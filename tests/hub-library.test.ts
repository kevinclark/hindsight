// Layout, dates, metadata, manifests, tags and facets of the library, on invented data.
process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import { dayText, libraryPath, schoolYear, withShaSuffix } from '../src/hub/layout.ts'
import { hootName, nameInstant } from '../src/hub/dates.ts'
import { seasonOf } from '../src/hub/season.ts'
import { describeLog } from '../src/hub/describe.ts'
import { Catalog, filesToFetch } from '../src/hub/catalog.ts'
import { countLabel, facetCounts, facetValues, filterEntries } from '../src/hub/facets.ts'
import { kindOf, parseManifest, serializeRecord, type LogRecord, type TagRecord } from '../src/hub/types.ts'
import { robotLog } from './helpers/hub-logs.ts'

const at = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).getTime() // local time

function log(over: Partial<LogRecord> & { sha256: string }): LogRecord {
  return {
    type: 'log', kind: 'wpilog', playedAt: at(2026, 10, 17), dateSource: 'robot clock', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null,
    onField: false, batteryId: null, robot: { profileId: 'p', name: 'Robot A', how: 'codebase', fit: 1 }, build: null, stub: false, hardwareId: null,
    size: 1, path: `logs/x/${over.sha256}.wpilog`, names: [`${over.sha256}.wpilog`], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'm1', ...over,
  }
}

describe('layout', () => {
  it('school years run August to July', () => {
    expect(schoolYear(at(2026, 7, 31))).toBe('2025-2026')
    expect(schoolYear(at(2026, 8, 1))).toBe('2026-2027')
    expect(schoolYear(at(2027, 1, 9))).toBe('2026-2027')
  })
  it('files by school year and local date, undated apart', () => {
    expect(libraryPath({ playedAt: at(2026, 10, 17, 23) }, 'a.wpilog')).toBe('logs/2026-2027/2026-10-17/a.wpilog')
    expect(libraryPath({ playedAt: null }, 'a.wpilog')).toBe('logs/undated/a.wpilog')
    expect(libraryPath({ playedAt: null }, '../x/a.wpilog')).toBe('logs/undated/.._x_a.wpilog')
    expect(dayText(at(2026, 1, 5))).toBe('2026-01-05')
  })
  it('adds the sha before the extension on a clash', () => {
    expect(withShaSuffix('logs/u/a.wpilog', 'abcdef0123456789')).toBe('logs/u/a-abcdef01.wpilog')
    expect(withShaSuffix('logs/u.d/noext', 'abcdef0123456789')).toBe('logs/u.d/noext-abcdef01')
  })
  it('knows what a log is by its extension', () => {
    expect(['a.WPILOG', 'b.hoot', 'c.dslog', 'd.dsevents', 'e.txt', 'wpilog'].map(kindOf)).toEqual(['wpilog', 'hoot', 'dslog', 'dsevents', null, null])
  })
})

describe('dates in names', () => {
  it('reads a 2026 AdvantageKit name as UTC and a 2025 one as Pacific', () => {
    expect(new Date(nameInstant('akit_26-10-17_20-07-34_x.wpilog')!).toISOString()).toBe('2026-10-17T20:07:34.000Z')
    expect(new Date(nameInstant('akit_25-03-20_10-00-00.wpilog')!).toISOString()).toBe('2025-03-20T17:00:00.000Z') // PDT
    expect(new Date(nameInstant('akit_24-12-18_10-00-00.wpilog')!).toISOString()).toBe('2024-12-18T18:00:00.000Z') // PST
    expect(nameInstant('Log_2.wpilog')).toBeNull()
    expect(nameInstant('akit_26-13-17_20-07-34.wpilog')).toBeNull()
  })
  it('reads a hoot name: serial and time', () => {
    expect(hootName('rio_2026-10-17_20-07-34.hoot')).toEqual({ hardwareId: 'rio', at: Date.UTC(2026, 9, 17, 20, 7, 34) })
    expect(hootName('ABC123_2026-10-17_20-07-34_more.hoot')?.hardwareId).toBe('ABC123')
    expect(hootName('mystery.hoot')).toBeNull()
  })
  it('season runs from kickoff to the end of Championship, any other day is off-season', () => {
    expect(seasonOf(at(2026, 1, 9))).toBe('off-season')
    expect(seasonOf(at(2026, 1, 10, 0))).toBe('season')
    expect(seasonOf(at(2026, 5, 2, 23))).toBe('season')
    expect(seasonOf(at(2026, 5, 3))).toBe('off-season')
    expect(seasonOf(at(2026, 10, 17))).toBe('off-season')
  })
})

describe('what a log says about itself', () => {
  it('reads the event, match, battery and wall clock', () => {
    const clock = Date.UTC(2026, 9, 17, 19, 0, 0)
    const m = describeLog('x.wpilog', robotLog({ clockMs: clock, enabled: [20, 55], event: 'TEST', fms: true, matchType: 3, matchNumber: 2, battery: 'B09' }))
    expect(m).toMatchObject({ event: 'TEST', matchType: 3, matchNumber: 2, onField: true, batteryId: 'B09', stub: false, dateSource: 'robot clock' })
    expect(m.matchWindow).toEqual({ start: clock + 20_000, end: clock + 55_000 })
    expect(m.wall!.start).toBeLessThanOrEqual(clock + 20_000)
  })
  it('calls a tiny never-enabled log a stub, and a long never-enabled one not', () => {
    expect(describeLog('akit_ab12.wpilog', robotLog({ seed: 's' })).stub).toBe(true)
    expect(describeLog('x.wpilog', robotLog({ enabled: [20, 55] })).stub).toBe(false)
  })
  it('files a hoot file by its name alone, without opening it', () => {
    const m = describeLog('ABC123_2026-10-17_20-07-34.hoot', new Uint8Array(0))
    expect(m).toMatchObject({ kind: 'hoot', hardwareId: 'ABC123', dateSource: 'file name' })
  })
  it('says why a file is unreadable', () => {
    expect(() => describeLog('a.wpilog', new Uint8Array(0))).toThrow(/empty/)
    expect(() => describeLog('a.wpilog', new TextEncoder().encode('hello world, not a log'))).toThrow(/Not a \.wpilog/)
    expect(() => describeLog('a.txt', new Uint8Array(3))).toThrow(/not a/)
  })
})

describe('manifests', () => {
  it('round-trips records and skips lines it does not understand', () => {
    const r = log({ sha256: 'aa' })
    const { records, skipped } = parseManifest(`${serializeRecord(r)}not json\n{"type":"mystery"}\n\n`)
    expect(records).toEqual([r])
    expect(skipped).toBe(2)
  })
  it('skips a tag with no usable target instead of letting it break every teammate\'s library', () => {
    const bad = ['null', '{}', '"x"', '{"log":5}'].map((t) => `{"type":"tag","field":"driver","value":"v","target":${t},"recordedAt":1,"machine":"m"}`).join('\n')
    expect(parseManifest(bad)).toEqual({ records: [], skipped: 4 })
    expect(() => Catalog.from([bad]).entries()).not.toThrow()
  })
  it('keeps the earliest record of the same bytes and all its names, from any machine', () => {
    const a = log({ sha256: 'aa', names: ['one.wpilog'], recordedAt: 5, machine: 'm2', path: 'logs/a/one.wpilog' })
    const b = log({ sha256: 'aa', names: ['two.wpilog'], recordedAt: 3, machine: 'm1', path: 'logs/b/two.wpilog' })
    const c = Catalog.from([serializeRecord(a), serializeRecord(b) + serializeRecord({ type: 'alias', sha256: 'aa', name: 'three.wpilog', recordedAt: 9, machine: 'm1' })])
    expect(c.size).toBe(1)
    expect(c.bySha('aa')!.path).toBe('logs/b/two.wpilog')
    expect(c.namesOf('aa').sort()).toEqual(['one.wpilog', 'three.wpilog', 'two.wpilog'])
  })
})

describe('tags and facets', () => {
  const tag = (target: TagRecord['target'], field: TagRecord['field'], value: string, recordedAt: number): TagRecord => ({ type: 'tag', target, field, value, recordedAt, machine: 'm1' })
  const day = dayText(at(2026, 10, 17))
  const logs = [
    log({ sha256: 'a1', onField: true, event: 'TEST', matchType: 2, matchNumber: 7, batteryId: 'B01' }),
    log({ sha256: 'a2', playedAt: at(2026, 10, 17, 15) }),
    log({ sha256: 'a3', playedAt: at(2027, 2, 20), onField: true, event: 'TEST', matchType: 3, batteryId: 'B02', robot: { profileId: 'q', name: 'Robot B', how: 'codebase', fit: 1 } }),
    log({ sha256: 'a4', playedAt: null, dateSource: 'unknown', stub: false }),
    log({ sha256: 'h1', kind: 'hoot', playedAt: at(2026, 10, 17), hardwareId: 'ABC123' }),
  ]
  const catalog = (extra: TagRecord[] = []) => Catalog.from([logs.map(serializeRecord).join('') + extra.map(serializeRecord).join('')])

  it('a tag on the log beats a tag on its day; the latest wins; an empty value clears', () => {
    const c = catalog([
      tag({ day }, 'place', 'Shop', 1), tag({ day }, 'driver', 'driver one', 2), tag({ log: 'a2' }, 'driver', 'driver two', 3),
      tag({ day }, 'place', 'Gym', 4), tag({ log: 'a1' }, 'driver', 'x', 5), tag({ log: 'a1' }, 'driver', '', 6),
    ])
    const by = Object.fromEntries(c.entries().map((e) => [e.record.sha256, e.tags]))
    expect(by.a2).toEqual({ place: 'Gym', driver: 'driver two' })
    expect(by.a1).toEqual({ place: 'Gym', driver: 'driver one' }) // cleared on the log, so the day's shows
    expect(by.a3).toEqual({})
    expect(by.a4).toEqual({})
  })

  it('computes the seven facets; a typed battery or robot replaces the logged one; the field names the event', () => {
    const c = catalog([tag({ log: 'a2' }, 'battery', 'B77', 1), tag({ day }, 'place', 'Shop', 1), tag({ log: 'a2' }, 'robot', 'Practice bot', 1)])
    const v = Object.fromEntries(c.entries().map((e) => [e.record.sha256, facetValues(e)]))
    expect(v.a1).toEqual({ schoolYear: '2026-2027', season: 'Off-season', place: 'TEST', matchType: 'Qualification', battery: 'B01', robot: 'Robot A', driver: 'No driver' })
    expect(v.a2).toMatchObject({ place: 'Shop', matchType: 'Not a match', battery: 'B77', robot: 'Practice bot' })
    expect(v.a3).toMatchObject({ schoolYear: '2026-2027', season: 'Season', matchType: 'Elimination' })
    expect(v.a4).toMatchObject({ schoolYear: 'No date', season: 'No date' })
  })

  it('shows the CANivore serial of a hoot file attached to the robot log in the robot facet', () => {
    const wall = { start: at(2026, 10, 17, 11), end: at(2026, 10, 17, 13) }
    const c = Catalog.from([[log({ sha256: 'b1', wall, matchWindow: wall }), log({ sha256: 'h2', kind: 'hoot', playedAt: at(2026, 10, 17, 12), hardwareId: 'ABC123', wall: null })].map(serializeRecord).join('')])
    expect(facetValues(c.entries()[0]).robot).toBe('Robot A · CANivore ABC123')
  })

  it('a download fetches the log and the DS and hoot files attached to it, only those the team has and this computer lacks', () => {
    const wall = { start: at(2026, 10, 17, 11), end: at(2026, 10, 17, 13) }
    const robot = log({ sha256: 'r1', wall, matchWindow: wall })
    const ds = log({ sha256: 'd2', kind: 'dslog', playedAt: at(2026, 10, 17, 12), wall })
    const hoot = log({ sha256: 'h3', kind: 'hoot', playedAt: at(2026, 10, 17, 12), wall: null })
    const [entry] = Catalog.from([[robot, ds, hoot].map(serializeRecord).join('')]).entries()
    expect(entry.attached.dslog.length + entry.attached.hoot.length).toBe(2)
    const paths = (held: string[], shared: string[]) => filesToFetch(entry, new Set(held), new Set(shared)).map((r) => r.sha256)
    const all = [robot.path, ds.path, hoot.path]
    expect(paths([], all)).toEqual(['r1', 'd2', 'h3']) // the second computer: all three, the .dslog included
    expect(paths([robot.path], all)).toEqual(['d2', 'h3']) // the log is here but its DS log is not: still something to fetch
    expect(paths(all, all)).toEqual([])
    expect(paths([], [robot.path])).toEqual(['r1']) // not in the team store: nothing to fetch for it
  })

  it('ORs picks within a facet and ANDs across facets', () => {
    const entries = catalog().entries()
    const names = (sel: Parameters<typeof filterEntries>[1]) => filterEntries(entries, sel).map((e) => e.record.sha256).sort()
    expect(names({})).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(names({ matchType: ['Qualification', 'Elimination'] })).toEqual(['a1', 'a3'])
    expect(names({ matchType: ['Qualification', 'Elimination'], season: ['Season'] })).toEqual(['a3'])
    expect(names({ robot: ['Robot A'], battery: ['B01', 'No battery'] })).toEqual(['a1', 'a2', 'a4'])
    expect(names({ schoolYear: ['No date'] })).toEqual(['a4'])
    expect(names({ driver: ['Nobody'] })).toEqual([])
  })

  it('counts a facet without its own picks, and keeps a picked value at zero', () => {
    const entries = catalog().entries()
    const counts = facetCounts(entries, { matchType: ['Qualification'], robot: ['Robot B'] })
    expect(Object.fromEntries(counts.matchType)).toEqual({ Elimination: 1, Qualification: 0 }) // robot B narrows it; Qualification stays listed
    expect(Object.fromEntries(counts.robot)).toEqual({ 'Robot A': 1, 'Robot B': 0 })
  })
  it('labels a count "+N" only beside a pick in the same facet', () => {
    const selection = { robot: ['Robot B'] }
    expect(countLabel(selection, 'robot', 'Robot A', 3)).toBe('+3') // would join the list: picks within a facet are OR
    expect(countLabel(selection, 'robot', 'Robot B', 2)).toBe('2')
    expect(countLabel(selection, 'battery', 'B1', 2)).toBe('2') // another facet narrows the list
    expect(countLabel({}, 'robot', 'Robot A', 3)).toBe('3')
  })
})
