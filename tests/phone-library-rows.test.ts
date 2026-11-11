// The phone Library's rows: matches and on-checks are rows, the other off-the-field logs fold, two logs of one match are one
// row; the Filters sheet's picks. Invented data only (event "TEST").
import { describe, expect, it } from 'vitest'
import { Catalog, type Entry } from '../src/hub/catalog.ts'
import { FACETS, facetCounts, filterEntries, robotLabels, type Selection } from '../src/hub/facets.ts'
import { eventPlaces } from '../src/hub/event-places.ts'
import { serializeRecord, type LogRecord } from '../src/hub/types.ts'
import { activeLine, clock, dayHeading, dayItems, rowParts, sheetFacets, whenOf } from '../src/ui/phone-library.ts'
import library from '../fixtures/phone/library.json'

/** A clock time as this device writes it (the test must not assume English). */
const t = (h: number, m: number, d = 8) => new Date(2099, 2, d, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const at = (d: number, h: number, m: number) => new Date(2099, 2, d, h, m).getTime() // local time

let n = 0
function log(over: Partial<LogRecord>): LogRecord {
  n++
  return {
    type: 'log', kind: 'wpilog', sha256: `s${n}`, size: 10 * 2 ** 20, path: `logs/x/s${n}.wpilog`, names: [`s${n}.wpilog`], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'm',
    playedAt: at(8, 9, 0), dateSource: 'robot', wall: null, matchWindow: null, event: 'TEST', matchType: null, matchNumber: null, onField: false, batteryId: null, roboRio: null, edition: null,
    robot: null, build: null, stub: false, hardwareId: null, ...over,
  } as LogRecord
}
const entries = (rs: LogRecord[]): Entry[] => Catalog.from([rs.map(serializeRecord).join('')]).entries()
const match = (d: number, h: number, m: number, num: number, over: Partial<LogRecord> = {}) => log({ playedAt: at(d, h, m), onField: true, matchType: 2, matchNumber: num, runs: { count: 1, seconds: [150] }, ...over })
const pit = (d: number, h: number, m: number, runs?: number[]) => log({ playedAt: at(d, h, m), ...(runs ? { runs: { count: runs.length, seconds: runs } } : {}) })
/** The list as the hub gives it: newest first. */
const newestFirst = (rs: LogRecord[]) => entries(rs).sort((a, b) => b.record.playedAt! - a.record.playedAt!)
const shape = (es: Entry[]) => dayItems(es).map((d) => d.items.map((i) => (i.type === 'fold' ? `fold(${i.entries.length}) ${i.text}` : `${i.muted ? 'muted ' : ''}${rowParts(i.entries[0]).label}${i.entries.length > 1 ? ` x${i.entries.length}` : ''}`)))

describe('dayItems', () => {
  it('makes rows of matches and on-checks, and folds the other off-field logs between two rows (a lone one stays a muted row)', () => {
    const es = newestFirst([
      match(8, 12, 0, 3), pit(8, 11, 50, []), pit(8, 11, 45, []), pit(8, 11, 40, [2]), // the newest quiet group: never folds
      match(8, 11, 0, 2), pit(8, 10, 10, [34, 5]), pit(8, 9, 59), pit(8, 9, 53, []), pit(8, 9, 49, [0.1]), // an on-check, an unread and a not-enabled log fold, a brief enable stays a row
      match(8, 9, 0, 1), pit(8, 8, 0, [0.1]), // lone, a muted row
      match(7, 17, 0, 9),
    ])
    expect(shape(es)).toEqual([
      ['Q3', 'muted Not enabled', 'muted Not enabled', 'muted On-check', 'Q2', 'muted On-check', `fold(2) 1 not enabled, 1 off the field · ${t(9, 53)}–${t(9, 59)}`, 'muted Enabled under 1 s', 'Q1', 'muted Enabled under 1 s'],
      ['Q9'],
    ])
  })
  it('never folds the newest group, but folds an older one of the same size', () => {
    const es = newestFirst([pit(8, 12, 0, []), pit(8, 11, 50, []), match(8, 11, 0, 1), pit(8, 10, 0, []), pit(8, 9, 50, [])])
    expect(shape(es)).toEqual([['muted Not enabled', 'muted Not enabled', 'Q1', `fold(2) 2 not enabled · ${t(9, 50)}–${t(10, 0)}`]])
  })
  it('counts every folded log (nothing is hidden without a count)', () => {
    const es = newestFirst([pit(9, 10, 5, []), pit(9, 10, 0, []), match(8, 12, 0, 2), pit(8, 11, 0, []), pit(8, 10, 0), pit(8, 9, 0, []), match(8, 8, 0, 1)])
    const fold = dayItems(es)[1].items.find((i) => i.type === 'fold')!
    expect(fold.entries.length).toBe(3)
    expect(fold.type === 'fold' && fold.text).toBe(`2 not enabled, 1 off the field · ${t(9, 0)}–${t(11, 0)}`)
  })
  it('merges two on-field logs of one match (same day, event, type, number) into one row, others stay apart', () => {
    const es = newestFirst([match(8, 11, 30, 1), match(8, 11, 0, 5), match(8, 9, 0, 1), match(8, 8, 0, 1, { event: 'OTHER' }), match(7, 9, 0, 1)])
    expect(shape(es)).toEqual([['Q1 x2', 'Q5', 'Q1'], ['Q1']])
    expect(dayItems(es)[0].items[0].entries.map((e) => e.record.playedAt)).toEqual([at(8, 11, 30), at(8, 9, 0)])
  })
  it('heads the day like "Sun Nov 8", and adds the year when it is not the current one', () => {
    const noon = new Date(2026, 10, 8, 12).getTime()
    expect(dayHeading(noon, new Date(2026, 10, 11).getTime())).toBe('Sun Nov 8')
    expect(dayHeading(noon, new Date(2027, 0, 5).getTime())).toBe('Sun Nov 8, 2026')
    expect(dayItems(newestFirst([match(8, 9, 0, 1)]))[0].heading).toBe('Sun Mar 8, 2099') // 2099 is not this year
  })
  it('prints a two-log match row\'s time once when both logs share it, and both when they differ', () => {
    const same = dayItems(newestFirst([match(8, 9, 0, 1), match(8, 9, 0, 1)]))[0].items[0]
    expect(whenOf(same.entries)).toBe(t(9, 0))
    const differ = dayItems(newestFirst([match(8, 9, 0, 1), match(8, 9, 2, 1)]))[0].items[0]
    expect(whenOf(differ.entries)).toBe(`${t(9, 2)}, ${t(9, 0)}`)
  })
})

describe('rowParts', () => {
  const parts = (r: LogRecord) => rowParts(entries([r])[0])
  it('words each kind of log', () => {
    expect(parts(match(8, 9, 0, 7))).toMatchObject({ label: 'Q7', when: t(9, 0), bold: true, muted: false })
    expect(parts(log({ onField: true, matchType: 1, matchNumber: 3 })).label).toBe('Practice 3')
    expect(parts(log({ onField: true, matchType: 3, matchNumber: 2 })).label).toBe('Playoff 2')
    expect(parts(pit(8, 12, 58, [20.4, 13.6]))).toMatchObject({ label: 'On-check', when: t(12, 58), extra: '34 s enabled', bold: false, muted: true })
    expect(parts(pit(8, 9, 51, []))).toMatchObject({ label: 'Not enabled', when: t(9, 51), extra: null, muted: true })
    expect(parts(pit(8, 9, 52, [0.3]))).toMatchObject({ label: 'Enabled under 1 s', when: t(9, 52), extra: null, muted: true })
    expect(parts(pit(8, 21, 5))).toMatchObject({ label: 'Off the field', when: t(21, 5), extra: null, muted: true })
  })
  it('writes clock times as the device does', () => {
    expect([at(8, 0, 5), at(8, 13, 7)].map(clock)).toEqual([t(0, 5), t(13, 7)])
    expect(clock(at(8, 9, 0))).toBe(new Date(at(8, 9, 0)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
  })
})

describe('the Filters sheet', () => {
  /** The fixture's rows as library entries, shaped like libraryManifest() in src/phone-fixture.ts makes them. */
  const rows = (library.rows as { day: number; minute: number; onField: boolean; matchType: number; matchNumber: number | null; event: boolean; wallSeconds: number; mb: number; runs: number[] }[])
  const fixture = entries(rows.map((r, i) => {
    const t = new Date(2099, 2, 6 + r.day, 0, r.minute).getTime()
    return log({ sha256: `f${i}`, playedAt: t, onField: r.onField, matchType: r.matchType, matchNumber: r.matchNumber, event: r.event ? 'TEST' : '', runs: { count: r.runs.length, seconds: r.runs } })
  }))
  const labels = robotLabels(fixture)

  it('has 36 invented rows spread over several days', () => {
    expect(fixture.length).toBe(36)
  })
  it('keeps every off-field log of the event when places are given, and drops them without', () => {
    const places = eventPlaces(fixture, new Map())
    const sel: Selection = { place: ['TEST'] }
    const withPlaces = filterEntries(fixture, sel, labels, places)
    expect(withPlaces.length).toBe(36)
    expect(filterEntries(fixture, sel, labels).length).toBeLessThan(36)
    const counts = facetCounts(fixture, sel, labels, places)
    expect(counts.logType.map(([v]) => v)).toEqual(expect.arrayContaining(['Qualification', 'On-check', 'Not enabled']))
    expect(counts.logType.reduce((s, [, c]) => s + c, 0)).toBe(36)
  })
  it('puts Log type first, and a facet with one value in the shown logs on one line instead of a checkbox', () => {
    const base = fixture.filter((e) => e.record.event === 'TEST') // a single event: the place facet has one value
    const sheet = sheetFacets(facetCounts(base, {}, labels, eventPlaces(base, new Map())), {})
    expect(sheet.multi[0]).toBe('logType')
    expect(sheet.multi).not.toContain('place')
    expect(sheet.single).toEqual(expect.arrayContaining([{ label: 'Event or practice place', value: 'TEST' }, { label: 'Robot', value: 'Unknown robot' }]))
    expect(sheet.single.every((x) => !!x.value)).toBe(true)
    expect(FACETS.length).toBe(7)
  })
  it('shows the active picks as one line with the shown and total counts', () => {
    expect(activeLine({ logType: ['Qualification', 'On-check'] }, 12, 36)).toBe('Qualification, On-check · 12 of 36 logs')
    expect(activeLine({ place: ['TEST'], logType: ['On-check'] }, 1, 1)).toBe('TEST, On-check · 1 of 1 log')
    expect(activeLine({}, 36, 36)).toBe('')
    expect(FACETS.length).toBe(7)
  })
})
