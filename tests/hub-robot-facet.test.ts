// The robot facet told apart by roboRIO and edition, and the two readings it rests on. Invented serials and editions only.
process.env.TZ = 'America/Los_Angeles'

import { describe, expect, it } from 'vitest'
import { Catalog } from '../src/hub/catalog.ts'
import { hootName } from '../src/hub/dates.ts'
import { describeLog } from '../src/hub/describe.ts'
import { facetCounts, facetValues, filterEntries, robotLabels } from '../src/hub/facets.ts'
import { serializeRecord, type LogRecord, type TagRecord } from '../src/hub/types.ts'
import { competition2026 } from '../src/profiles/2026-competition.ts'
import { parseProfileJson } from '../src/builder/json.ts'
import { fromProfile, toProfile } from '../src/builder/json.ts'
import { robotLog } from './helpers/hub-logs.ts'

let n = 0
/** A robot log of robot "Bot" on the given roboRIO and edition; `at` orders the logs (ms). */
function bot(roboRio: string | null, edition: string | null, over: Partial<LogRecord> = {}): LogRecord {
  const sha256 = `s${++n}`
  return {
    type: 'log', sha256, kind: 'wpilog', playedAt: Date.UTC(2026, 9, 17, 19) + n * 1000, dateSource: 'robot clock', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null,
    onField: false, batteryId: null, roboRio, edition, robot: { profileId: 'p', name: 'Bot', how: 'codebase', fit: 1 }, build: null, stub: false, hardwareId: null,
    size: 1, path: `logs/x/${sha256}.wpilog`, names: [`${sha256}.wpilog`], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'm1', ...over,
  }
}
const library = (records: LogRecord[], tags: TagRecord[] = []) => Catalog.from([[...records, ...tags].map(serializeRecord).join('')])
const labelsOf = (records: LogRecord[]) => {
  const c = library(records)
  const labels = robotLabels(c.entries())
  return records.map((r) => labels.get(r.sha256)!)
}
const A = '0ABC1234'
const B = '0DEF5678'

describe('robot labels', () => {
  it('keeps the plain name for one roboRIO, whatever the edition says', () => {
    expect(labelsOf([bot(A, 'ALPHA'), bot(A, 'BETA'), bot(A, null)]).map((l) => l.label)).toEqual(['Bot', 'Bot', 'Bot'])
    expect(labelsOf([bot(null, null), bot(A, null)]).map((l) => l.label)).toEqual(['Bot', 'Bot'])
  })
  it('names each log by its edition when there are two roboRIOs and an edition is logged', () => {
    const l = labelsOf([bot(A, 'ALPHA'), bot(B, 'BETA'), bot(B, 'BETA')])
    expect(l.map((x) => x.label)).toEqual(['Bot · ALPHA', 'Bot · BETA', 'Bot · BETA'])
    expect(l.every((x) => x.group === 'Bot' && !x.guess)).toBe(true)
  })
  it('gives an edition-less log the one edition its roboRIO has elsewhere, marked as a guess', () => {
    const l = labelsOf([bot(A, 'ALPHA'), bot(A, null), bot(B, 'BETA')])
    expect(l[1]).toEqual({ label: 'Bot · ALPHA', group: 'Bot', guess: true })
    expect(l[0].guess).toBe(false)
  })
  it('falls to the roboRIO rule when the roboRIO has no edition or two', () => {
    const l = labelsOf([bot(A, 'ALPHA'), bot(A, 'ALPHA'), bot(B, 'BETA'), bot(B, 'ALPHA'), bot(B, null), bot('0GHI9012', null)])
    expect(l[4].label).toBe('Bot') // B names two editions: no guess; B has 3 logs, A 2: B is the main roboRIO
    expect(l[5]).toMatchObject({ label: 'Bot · other roboRIO …9012', guess: false })
  })
  it('with no edition, the roboRIO with most logs keeps the plain name; a tie goes to the earlier one', () => {
    expect(labelsOf([bot(A, null), bot(B, null), bot(B, null)]).map((l) => l.label)).toEqual(['Bot · other roboRIO …1234', 'Bot', 'Bot'])
    expect(labelsOf([bot(B, null), bot(A, null)]).map((l) => l.label)).toEqual(['Bot', 'Bot · other roboRIO …1234'])
  })
  it('keeps the plain name for a log with no roboRIO in a split group (no such log in the library today)', () => {
    expect(labelsOf([bot(A, null), bot(B, null), bot(B, null), bot(null, null)]).at(-1)!.label).toBe('Bot')
  })
  it('lets a typed robot win, in its own group, and names a log with no robot "Unknown robot"', () => {
    const typed = bot(A, 'ALPHA')
    const c = library([typed, bot(B, 'BETA'), bot(null, null, { robot: null })], [{ type: 'tag', target: { log: typed.sha256 }, field: 'robot', value: 'Practice bot', recordedAt: 2, machine: 'm1' }])
    const labels = robotLabels(c.entries())
    expect(labels.get(typed.sha256)).toEqual({ label: 'Practice bot', group: 'Practice bot', guess: false })
    expect(labels.get('s' + (n))).toMatchObject({ label: 'Unknown robot' })
    expect(labels.get('s' + (n - 1))).toMatchObject({ label: 'Bot' }) // alone with its roboRIO once the other is typed away
  })
  it('is decided over the whole library: a filter that hides one roboRIO does not rename the other', () => {
    const records = [bot(A, 'ALPHA'), bot(B, 'BETA'), bot(B, 'BETA')]
    const entries = library(records).entries()
    const labels = robotLabels(entries)
    const onlyB = filterEntries(entries, { robot: ['Bot · BETA'] }, labels)
    expect(onlyB).toHaveLength(2)
    expect(facetValues(onlyB[0], robotLabels(onlyB)).robot).toBe('Bot') // what a per-list decision would say
    expect(facetValues(onlyB[0], labels).robot).toBe('Bot · BETA')
  })
  it('lists robots by their group size, each group plain name first, then by count', () => {
    const records = [
      ...[1, 2, 3].map(() => bot(null, null, { robot: { profileId: 'q', name: 'Zed', how: 'codebase', fit: 1 } })),
      bot(A, null), bot(A, null), bot(B, null), bot(B, null), bot(B, null), bot(B, null), bot('0GHI9012', null),
    ]
    const entries = library(records).entries()
    const counts = facetCounts(entries, {}, robotLabels(entries)).robot
    expect(counts).toEqual([['Bot', 4], ['Bot · other roboRIO …1234', 2], ['Bot · other roboRIO …9012', 1], ['Zed', 3]])
  })
})

describe('the hoot file name', () => {
  it('takes the token before the time as the id, dropping a match prefix', () => {
    expect(hootName('TEST_Q43_0ABC1234_2025-07-06_14-38-23.hoot')?.hardwareId).toBe('0ABC1234')
    expect(hootName('TESTQ13_rio_2025-07-06_14-38-23.hoot')?.hardwareId).toBe('rio')
    expect(hootName('rio_2026-10-17_20-07-34.hoot')?.hardwareId).toBe('rio')
    expect(hootName('0ABC1234_2026-10-17_20-07-34_more.hoot')?.hardwareId).toBe('0ABC1234')
  })

  it('reads the first time when the suffix holds a second one', () => {
    expect(hootName('rio_2026-10-17_20-07-34_2026-10-17_20-37-34.hoot')).toEqual({ hardwareId: 'rio', at: Date.UTC(2026, 9, 17, 20, 7, 34) })
  })
})

describe('reading the roboRIO and edition', () => {
  const CLOCK = Date.UTC(2026, 9, 17, 19)
  it('reads the roboRIO serial from AdvantageKit\'s SystemStats, skipping an empty first value', () => {
    expect(describeLog('x.wpilog', robotLog({ clockMs: CLOCK, roboRio: A })).roboRio).toBe(A)
    expect(describeLog('x.wpilog', robotLog({ clockMs: CLOCK })).roboRio).toBeNull()
  })
  it('reads the edition only for a profile that declares where its code records it', () => {
    const named = { clockMs: CLOCK, codebase: competition2026.codebase, branch: competition2026.code.branch, edition: 'ALPHA' }
    expect(describeLog('x.wpilog', robotLog(named)).edition).toBe('ALPHA')
    expect(describeLog('x.wpilog', robotLog({ ...named, codebase: '2026 Offseason' })).edition).toBeNull()
  })
  it('a hoot file has neither', () => {
    expect(describeLog('0ABC1234_2026-10-17_20-07-34.hoot', new Uint8Array(0))).toMatchObject({ roboRio: null, edition: null })
  })
  it('a kept profile with an editionKey round-trips, and one without still reads', () => {
    expect(toProfile(parseProfileJson(JSON.stringify(fromProfile(competition2026)))).editionKey).toBe(competition2026.editionKey)
    const { editionKey: _e, ...without } = fromProfile(competition2026)
    expect(toProfile(parseProfileJson(JSON.stringify(without))).editionKey).toBeUndefined()
  })
})
