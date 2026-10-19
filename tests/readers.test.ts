import { describe, expect, it } from 'vitest'
import { hasEntry, openWpilog, readNumbers, readValues } from '../src/readers/wpilog.ts'
import { readDslog } from '../src/readers/dslog.ts'
import { makeGrid, resample, valueAt } from '../src/match/series.ts'
import { writeDslog, writeWpilog } from './helpers/fixture-format.ts'

describe('wpilog reader', () => {
  const bytes = writeWpilog([
    { name: '/d', type: 'double', records: [[1, 1.5], [2, -2.25]] },
    { name: '/f', type: 'float', records: [[1, 0.5]] },
    { name: '/b', type: 'boolean', records: [[1, false], [3, true]] },
    { name: '/i', type: 'int64', records: [[1, 42], [2, -7]] },
    { name: '/s', type: 'string', records: [[1, 'Rezeroed hood']] },
    { name: '/j', type: 'json', records: [[1, '{"a":1}']] },
    { name: '/sa', type: 'string[]', records: [[1, ['one', 'two']], [2, []]] },
    { name: '/da', type: 'double[]', records: [[1, [1, 2, 3] as never]] },
    { name: '/rot', type: 'struct:Rotation2d', records: [[1, Math.PI / 2]] },
    { name: '/pose', type: 'struct:Pose2d', records: [[1, { x: 1, y: 2, rot: 0.5 }]] },
  ])
  const log = openWpilog(bytes)

  it('indexes every entry and record', () => {
    expect(log.entries.size).toBe(10)
    expect(log.recordCount).toBe(14)
    expect(log.warnings).toEqual([])
  })
  it('decodes numbers, booleans and Rotation2d as numbers', () => {
    expect(Array.from(readNumbers(log, '/d')!.v)).toEqual([1.5, -2.25])
    expect(readNumbers(log, '/f')!.v[0]).toBeCloseTo(0.5)
    expect(Array.from(readNumbers(log, '/b')!.v)).toEqual([0, 1])
    expect(Array.from(readNumbers(log, '/i')!.v)).toEqual([42, -7])
    expect(readNumbers(log, '/rot')!.v[0]).toBeCloseTo(Math.PI / 2)
    expect(Array.from(readNumbers(log, '/d')!.t)).toEqual([1, 2])
  })
  it('decodes strings, json, arrays and structs', () => {
    expect(readValues(log, '/s')!.v).toEqual(['Rezeroed hood'])
    expect(readValues(log, '/j')!.v).toEqual(['{"a":1}'])
    expect(readValues(log, '/sa')!.v).toEqual([['one', 'two'], []])
    expect(readValues(log, '/da')!.v).toEqual([[1, 2, 3]])
    expect(readValues(log, '/pose')!.v).toEqual([{ x: 1, y: 2, rot: 0.5 }])
  })
  it('returns null for a missing entry, so rules can say "not checked"', () => {
    expect(readNumbers(log, '/nope')).toBeNull()
    expect(hasEntry(log, '/nope')).toBe(false)
  })
  it('refuses a number read of a string entry', () => {
    expect(() => readNumbers(log, '/s')).toThrow(/not a single number/)
  })
  it('warns (not throws) when the file ends mid-record', () => {
    const cut = openWpilog(bytes.subarray(0, bytes.length - 3))
    expect(cut.warnings[0]).toMatch(/last record is cut off/)
    expect(cut.recordCount).toBe(13)
  })
  it('rejects a file that is not a wpilog', () => {
    expect(() => openWpilog(new TextEncoder().encode('hello world, not a log'))).toThrow(/Not a .wpilog/)
  })
})

describe('hold-last resampling', () => {
  const s = { name: 'x', t: Float64Array.from([1, 2]), v: Float64Array.from([10, 20]) }
  it('holds the last value and never interpolates', () => {
    expect(valueAt(s, 1.5)).toBe(10)
    expect(valueAt(s, 2)).toBe(20)
    expect(Number.isNaN(valueAt(s, 0.5))).toBe(true)
    expect(Array.from(resample(s, makeGrid(0.5, 2.5, 0.5)))).toEqual([NaN, 10, 10, 20])
  })
})

describe('dslog reader', () => {
  it('reads the header time, records and the "no robot" marker', () => {
    const ds = readDslog(writeDslog({ name: 'x', startEpochSeconds: 1792267633.345, count: 100, robotFrom: 10, noRobotFrom: 60 }))
    expect(ds.version).toBe(4)
    expect(ds.startEpochSeconds).toBeCloseTo(1792267633.345, 3)
    expect(ds.records).toHaveLength(100)
    expect(ds.records[5].voltage).toBeNull()
    expect(ds.records[20].voltage).toBeCloseTo(12.5)
    expect(ds.records[20].tripTimeMs).toBe(6)
    expect(ds.records[20].brownout).toBe(false)
    expect(ds.records[99].epochSeconds - ds.records[0].epochSeconds).toBeCloseTo(1.98)
  })
  it('skips REV power-distribution data in each record', () => {
    const plain = writeDslog({ name: 'x', startEpochSeconds: 0, count: 3, robotFrom: 0, noRobotFrom: 3 })
    const withPd = new Uint8Array(20 + 3 * (14 + 33))
    withPd.set(plain.subarray(0, 20))
    for (let i = 0; i < 3; i++) {
      withPd.set(plain.subarray(20 + i * 14, 20 + i * 14 + 14), 20 + i * 47)
      withPd[20 + i * 47 + 13] = 33 // REV PDH
    }
    const ds = readDslog(withPd)
    expect(ds.records).toHaveLength(3)
    expect(ds.records[2].voltage).toBeCloseTo(12.5)
  })
  it('rejects other versions', () => {
    const b = writeDslog({ name: 'x', startEpochSeconds: 0, count: 1, robotFrom: 0, noRobotFrom: 1 })
    b[3] = 3
    expect(() => readDslog(b)).toThrow(/version 3/)
  })
})
