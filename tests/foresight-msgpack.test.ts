import { describe, expect, it } from 'vitest'
import { encode } from '@msgpack/msgpack'
import { decodeMsgpackStream } from '../src/foresight/msgpack.ts'

const roundTrip = (v: unknown): unknown => decodeMsgpackStream(encode(v))[0]

describe('msgpack decoder', () => {
  it('decodes nil and booleans', () => {
    expect(decodeMsgpackStream(encode(null))).toEqual([null])
    expect(decodeMsgpackStream(encode(true))).toEqual([true])
    expect(decodeMsgpackStream(encode(false))).toEqual([false])
  })

  it.each([
    0, 1, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 40, Number.MAX_SAFE_INTEGER,
    -1, -32, -33, -127, -128, -129, -32768, -32769, -(2 ** 31), -(2 ** 31) - 1, -(2 ** 40), Number.MIN_SAFE_INTEGER,
  ])('round-trips the integer %d', (n) => {
    expect(roundTrip(n)).toBe(n)
  })

  it('uses every integer width the encoder offers', () => {
    // first byte tells which format was written: fixint, uint8/16/32/64, int8/16/32/64
    const firstBytes = [127, 255, 65535, 2 ** 32 - 1, 2 ** 32, -32, -128, -32768, -(2 ** 31), -(2 ** 31) - 1].map((n) => encode(n)[0])
    expect(firstBytes).toEqual([0x7f, 0xcc, 0xcd, 0xce, 0xcf, 0xe0, 0xd0, 0xd1, 0xd2, 0xd3])
  })

  it('decodes float64, including an integer-valued one', () => {
    for (const n of [0.1234, -1e300, 1.5, Infinity]) expect(roundTrip(n)).toBe(n)
    const bytes = new Uint8Array([0xcb, 0x40, 0, 0, 0, 0, 0, 0, 0])
    expect(decodeMsgpackStream(bytes)).toEqual([2])
  })

  it('decodes float32 (written by the library and by hand)', () => {
    expect(decodeMsgpackStream(encode(1.5, { forceFloat32: true }))).toEqual([1.5])
    expect(encode(1.5, { forceFloat32: true })[0]).toBe(0xca)
    expect(decodeMsgpackStream(new Uint8Array([0xca, 0x3f, 0xc0, 0, 0]))).toEqual([1.5])
    expect(decodeMsgpackStream(encode(0.1, { forceFloat32: true }))[0]).toBeCloseTo(0.1, 6)
  })

  it.each([0, 1, 31, 32, 255, 256, 65535, 65536])('round-trips a string of %d characters', (n) => {
    const s = 'a'.repeat(n)
    expect(roundTrip(s)).toBe(s)
  })

  it('decodes UTF-8 text', () => {
    expect(roundTrip('héllo ✓ 🤖')).toBe('héllo ✓ 🤖')
  })

  it.each([0, 1, 15, 16, 65535, 65536])('round-trips an array of %d items', (n) => {
    const a = Array.from({ length: n }, (_, i) => i % 300)
    expect(roundTrip(a)).toEqual(a)
  })

  it.each([0, 1, 255, 256, 65535, 65536])('round-trips %d bytes of binary as a copy', (n) => {
    const src = Uint8Array.from({ length: n }, (_, i) => i % 251)
    const buf = encode(src)
    const out = decodeMsgpackStream(buf)[0] as Uint8Array
    expect(out).toBeInstanceOf(Uint8Array)
    expect(Array.from(out)).toEqual(Array.from(src))
    buf.fill(0) // changing the input must not change the copy
    expect(Array.from(out.subarray(0, 4))).toEqual(Array.from(src.subarray(0, 4)))
  })

  it('round-trips nested maps, including big ones', () => {
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]))
    const v = { a: { b: [1, { c: 'x' }, null], d: true }, big, empty: {}, list: [[], [[]]] }
    expect(roundTrip(v)).toEqual(v)
    const huge = Object.fromEntries(Array.from({ length: 70000 }, (_, i) => [`k${i}`, i]))
    expect(Object.keys(roundTrip(huge) as object)).toHaveLength(70000)
  })

  it('decodes an NT4 message as the spec shows it', () => {
    // spec example: topic 50, timestamp 2 minutes, double 0.1234
    const bytes = new Uint8Array([0x94, 0x32, 0xd2, 0x07, 0x27, 0x0e, 0x00, 0x01, 0xcb, 0x3f, 0xbf, 0x97, 0x24, 0x74, 0x53, 0x8e, 0xf3])
    expect(decodeMsgpackStream(bytes)).toEqual([[50, 0x07270e00, 1, 0.1234]])
  })

  it('decodes several values concatenated in one buffer, in order', () => {
    const parts = [encode([1, 1000, 1, 0.5]), encode([2, 2000, 0, true]), encode('x'), encode(null)]
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) { joined.set(p, o); o += p.length }
    expect(decodeMsgpackStream(joined)).toEqual([[1, 1000, 1, 0.5], [2, 2000, 0, true], 'x', null])
  })

  it('decodes an empty buffer to nothing', () => {
    expect(decodeMsgpackStream(new Uint8Array())).toEqual([])
  })

  it('works on a view into a bigger buffer', () => {
    const inner = encode([1, 2, 3])
    const outer = new Uint8Array(inner.length + 6)
    outer.set(inner, 3)
    expect(decodeMsgpackStream(outer.subarray(3, 3 + inner.length))).toEqual([[1, 2, 3]])
  })

  it('throws, naming the offset, on a truncated buffer', () => {
    const whole = encode([1, 1000, 1, 'hello world'])
    for (let cut = 1; cut < whole.length; cut++) expect(() => decodeMsgpackStream(whole.subarray(0, cut))).toThrow(/byte \d+/)
    expect(() => decodeMsgpackStream(new Uint8Array([0xcb, 1, 2]))).toThrow(/byte 1/)
  })

  it('throws on 0xc1 and on ext types, with the offset', () => {
    expect(() => decodeMsgpackStream(new Uint8Array([0xc0, 0xc1]))).toThrow(/0xc1 at byte 1/)
    expect(() => decodeMsgpackStream(new Uint8Array([0xd4, 1, 2]))).toThrow(/0xd4 at byte 0/)
    expect(() => decodeMsgpackStream(new Uint8Array([0xc7, 1, 1, 2]))).toThrow(/unsupported/)
  })
})
