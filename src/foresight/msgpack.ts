/**
 * A small MessagePack decoder for NetworkTables 4 binary frames (Foresight reads the robot's live NT4 stream in
 * the browser). One WebSocket frame can hold several `[topicId, timestampUs, typeIdx, value]` arrays back to back,
 * so the entry point decodes a whole buffer of concatenated values. No dependency: NT4 uses a small subset.
 *
 * Not supported on purpose: ext types and the reserved byte 0xc1 (NT4 never sends them) throw, like a truncated
 * buffer, with the byte offset so a bad frame can be found in a capture.
 */

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** Decode every msgpack value in the buffer, in order. */
export function decodeMsgpackStream(bytes: Uint8Array): unknown[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 0
  const out: unknown[] = []
  while (pos < bytes.length) out.push(value())
  return out

  /** Move past n bytes and return where they started; throws if the buffer ends first. */
  function take(n: number): number {
    if (pos + n > bytes.length) throw new Error(`msgpack: buffer ends at byte ${bytes.length}, needed ${n} more at byte ${pos}`)
    const at = pos
    pos += n
    return at
  }

  function text(n: number): string {
    const at = take(n)
    try { return utf8.decode(bytes.subarray(at, at + n)) } catch { throw new Error(`msgpack: invalid UTF-8 string at byte ${at}`) }
  }

  function array(n: number): unknown[] {
    const items: unknown[] = []
    for (let i = 0; i < n; i++) items.push(value())
    return items
  }

  function map(n: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < n; i++) {
      const at = pos
      const key = value()
      if (typeof key !== 'string') throw new Error(`msgpack: map key at byte ${at} is not a string`)
      obj[key] = value()
    }
    return obj
  }

  function bin(n: number): Uint8Array {
    const at = take(n)
    return bytes.slice(at, at + n)
  }

  function value(): unknown {
    const at = pos
    const b = bytes[take(1)]
    if (b <= 0x7f) return b // positive fixint
    if (b >= 0xe0) return b - 0x100 // negative fixint
    if (b >= 0xa0 && b <= 0xbf) return text(b & 0x1f) // fixstr
    if (b >= 0x90 && b <= 0x9f) return array(b & 0x0f) // fixarray
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f) // fixmap
    switch (b) {
      case 0xc0: return null
      case 0xc2: return false
      case 0xc3: return true
      case 0xc4: return bin(view.getUint8(take(1)))
      case 0xc5: return bin(view.getUint16(take(2)))
      case 0xc6: return bin(view.getUint32(take(4)))
      case 0xca: return view.getFloat32(take(4))
      case 0xcb: return view.getFloat64(take(8))
      case 0xcc: return view.getUint8(take(1))
      case 0xcd: return view.getUint16(take(2))
      case 0xce: return view.getUint32(take(4))
      case 0xcf: return Number(view.getBigUint64(take(8)))
      case 0xd0: return view.getInt8(take(1))
      case 0xd1: return view.getInt16(take(2))
      case 0xd2: return view.getInt32(take(4))
      case 0xd3: return Number(view.getBigInt64(take(8)))
      case 0xd9: return text(view.getUint8(take(1)))
      case 0xda: return text(view.getUint16(take(2)))
      case 0xdb: return text(view.getUint32(take(4)))
      case 0xdc: return array(view.getUint16(take(2)))
      case 0xdd: return array(view.getUint32(take(4)))
      case 0xde: return map(view.getUint16(take(2)))
      case 0xdf: return map(view.getUint32(take(4)))
    }
    throw new Error(`msgpack: unsupported type byte 0x${b.toString(16)} at byte ${at}`)
  }
}
