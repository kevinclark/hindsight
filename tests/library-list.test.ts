// The laptop Library list: newest first, and each row's log type in the facet's words. Invented data only (event "TEST").
import { describe, expect, it } from 'vitest'
import { Catalog, type Entry } from '../src/hub/catalog.ts'
import { byNewest, logTypeWords } from '../src/hub/facets.ts'
import { serializeRecord, type LogRecord } from '../src/hub/types.ts'

let n = 0
const at = (d: number, h: number, m: number) => new Date(2099, 2, d, h, m).getTime()
function log(over: Partial<LogRecord>): LogRecord {
  n++
  return {
    type: 'log', kind: 'wpilog', sha256: `s${n}`, size: 10, path: `logs/x/s${n}.wpilog`, names: [`s${n}.wpilog`], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'm',
    playedAt: at(8, 9, 0), dateSource: 'robot', wall: null, matchWindow: null, event: 'TEST', matchType: null, matchNumber: null, onField: false, batteryId: null, roboRio: null, edition: null,
    robot: null, build: null, stub: false, hardwareId: null, ...over,
  } as LogRecord
}
const entries = (rs: LogRecord[]): Entry[] => Catalog.from([rs.map(serializeRecord).join('')]).entries()

describe('byNewest', () => {
  it('puts the newest day and the newest log of a day first, undated last, ties by path', () => {
    const rs = [
      log({ playedAt: at(7, 9, 0), path: 'a' }), log({ playedAt: at(8, 9, 0), path: 'b' }), log({ playedAt: at(8, 15, 0), path: 'c' }),
      log({ playedAt: null, path: 'd' }), log({ playedAt: at(8, 15, 0), path: 'a2' }),
    ]
    expect(entries(rs).sort(byNewest).map((e) => e.record.path)).toEqual(['a2', 'c', 'b', 'a', 'd'])
  })
})

describe('logTypeWords', () => {
  const w = (over: Partial<LogRecord>) => logTypeWords(log(over))
  it('names a match by the facet word and its number', () => {
    expect(w({ onField: true, matchType: 2, matchNumber: 47 })).toBe('Qualification 47')
    expect(w({ onField: true, matchType: 1, matchNumber: 3 })).toBe('Practice match 3')
    expect(w({ onField: true, matchType: 3, matchNumber: 5 })).toBe('Elimination 5')
    expect(w({ onField: true, matchType: 2, matchNumber: null })).toBe('Qualification')
    expect(w({ onField: true, matchType: 0 })).toBe('Not a match')
  })
  it('names an off-field log by what its runs say', () => {
    expect(w({ runs: { count: 1, seconds: [33.6] } })).toBe('On-check · 34 s enabled')
    expect(w({ runs: { count: 0, seconds: [] } })).toBe('Not enabled')
    expect(w({ runs: { count: 1, seconds: [0.4] } })).toBe('Enabled under 1 s')
    expect(w({})).toBe('Off the field (not read)')
  })
})
