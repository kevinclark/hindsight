// "Read again": what changed in the findings, and which saved summaries are current, older but showable, or hidden.
import { describe, expect, it } from 'vitest'
import { changeText, diffFindings, type FindingSnapshot } from '../src/session/changes.ts'
import { splitSaved, staleNote, type SavedSummary } from '../src/session/stale.ts'
import { buildSessionJson } from '../src/session/export.ts'
import { SUMMARY_SHAPE, summarizeLog, type MatchSummary } from '../src/session/summary.ts'
import { loadFixture } from './helpers/load.ts'

const snap = (key: string, fired: number, checkable: number, over: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  key, severity: 'warning', title: `${key} title`, fired, checkable,
  confidence: fired === 0 ? 'quiet' : fired === 1 ? 'once' : fired / checkable > 0.5 && checkable >= 3 ? 'consistent' : 'intermittent',
  ...over,
})

describe('diffFindings', () => {
  it('a new finding, a gone finding, a changed one and an unchanged one', () => {
    const before = [snap('b/gone', 2, 3), snap('c/changed', 1, 4), snap('d/same', 3, 3)]
    const after = [snap('e/new', 1, 4), snap('c/changed', 3, 4), snap('d/same', 3, 3)]
    const changes = diffFindings(before, after)
    expect(changes.map((c) => [c.kind, c.key])).toEqual([['new', 'e/new'], ['gone', 'b/gone'], ['changed', 'c/changed']])
    const changed = changes.find((c) => c.kind === 'changed')!
    expect(changed.before).toEqual({ confidence: 'once', fired: 1, checkable: 4, severity: 'warning' })
    expect(changed.after).toEqual({ confidence: 'consistent', fired: 3, checkable: 4, severity: 'warning' })
  })
  it('nothing changed: an empty list', () => {
    const same = [snap('a/x', 2, 3), snap('b/y', 1, 3)]
    expect(diffFindings(same, same.map((f) => ({ ...f, title: 'a newer wording' })))).toEqual([])
  })
  it('the same confidence with another "k of n" counts as changed', () => {
    const [c] = diffFindings([snap('a/x', 2, 5)], [snap('a/x', 2, 4)])
    expect(c.kind).toBe('changed')
    expect(changeText(c)).toBe('Changed: a/x title (a/x; Intermittent, 2 of 5 → Intermittent, 2 of 4)')
  })
  it('a severity change alone counts as changed and is shown', () => {
    const [c] = diffFindings([snap('a/x', 3, 3)], [snap('a/x', 3, 3, { severity: 'error' })])
    expect(c.kind).toBe('changed')
    expect(changeText(c)).toBe('Changed: a/x title (a/x; Consistent, 3 of 3; warning → error)')
  })
  it('worst severity first, then new, gone, changed', () => {
    const before = [snap('w/gone', 2, 3), snap('i/changed', 1, 3, { severity: 'info' }), snap('e/changed', 1, 3, { severity: 'error' })]
    const after = [snap('w/new', 1, 3), snap('i/changed', 2, 3, { severity: 'info' }), snap('e/changed', 2, 3, { severity: 'error' })]
    expect(diffFindings(before, after).map((c) => c.key)).toEqual(['e/changed', 'w/new', 'w/gone', 'i/changed'])
  })
  it('says new and gone in words', () => {
    const [n, g] = [diffFindings([], [snap('a/x', 3, 3)])[0], diffFindings([snap('b/y', 1, 4)], [])[0]]
    expect(changeText(n)).toBe('New: a/x title (a/x; Consistent, 3 of 3)')
    expect(changeText(g)).toBe('Gone: b/y title (b/y; was Once, 1 of 4)')
  })
})

describe('splitSaved: current, older with the same shape, older with another shape', () => {
  const saved = (key: string, over: Partial<SavedSummary>): SavedSummary => ({
    key, build: 'new', savedAt: '2026-10-01T10:00:00.000Z', shape: SUMMARY_SHAPE, version: '0.1.0', summary: { fileName: `${key}.wpilog` } as MatchSummary, ...over,
  })
  const all = [
    saved('now', {}),
    saved('old-same', { build: 'old' }),
    saved('old-other', { build: 'old', shape: SUMMARY_SHAPE + 1 }),
    saved('old-none', { build: 'old', shape: undefined }),
  ]
  const split = splitSaved(all, 'new', SUMMARY_SHAPE)
  it('keeps every entry and sorts it', () => {
    expect(split.current.map((c) => c.key)).toEqual(['now'])
    expect(split.stale.map((c) => c.key)).toEqual(['old-same'])
    expect(split.otherShape.map((c) => c.key)).toEqual(['old-other', 'old-none'])
  })
  it('a copy saved before the shape was kept is not shown', () => {
    expect(split.stale.some((c) => c.key === 'old-none')).toBe(false)
  })
})

describe('the note about older readings', () => {
  it('names the count, the version and the date', () => {
    expect(staleNote([{ version: '0.1.0', savedAt: '2026-10-05T12:00:00.000Z' }, { version: '0.1.0', savedAt: '2026-10-06T12:00:00.000Z' }], 0))
      .toBe('2 logs were read with an older Hindsight (version 0.1.0, saved 2026-10-05). Read again to update the conclusions.')
  })
  it('adds the count that cannot be shown, and says nothing when there is nothing to say', () => {
    expect(staleNote([{ savedAt: '2026-10-05T12:00:00.000Z' }], 3)).toMatch(/^1 log was read with an older Hindsight \(saved 2026-10-05\)\..*3 more saved log summaries were made by a Hindsight too old/)
    expect(staleNote([], 0)).toBeNull()
  })
})

describe('session-findings.json', () => {
  const session = { id: 's', label: 's', kind: 'event' as const, matches: [] as MatchSummary[] }
  it('has changedOnReread only when given one', () => {
    expect(buildSessionJson(session)).not.toHaveProperty('changedOnReread')
    const changes = diffFindings([], [snap('a/x', 3, 3)])
    const json = buildSessionJson(session, new Map(), {}, changes) as { schema: string; changedOnReread: { changes: unknown[] } }
    expect(json.schema).toBe('hindsight.session-findings/1')
    expect(json.changedOnReread.changes).toHaveLength(1)
    expect(buildSessionJson(session, new Map(), {}, [])).toHaveProperty('changedOnReread.changes', [])
  })
})

describe('the shape of a saved summary', () => {
  it('has the keys SUMMARY_SHAPE was set for', () => {
    const [log] = loadFixture('auto-and-comms').filter((f) => f.name.endsWith('.wpilog'))
    const summary = summarizeLog(log)!
    // What a summary of one log has. Keys present only sometimes (pieces) aren't on a single log and aren't pinned.
    const keys = Object.keys(summary).sort()
    expect(keys, 'MatchSummary changed: bump SUMMARY_SHAPE in src/session/summary.ts if old summaries can\'t be drawn, then update this list').toEqual(EXPECTED_KEYS)
  })
})
const EXPECTED_KEYS = [
  'batteryId', 'build', 'clockNote', 'event', 'fileName', 'fileSize', 'logging', 'matchLabel', 'matchType', 'metrics', 'onField',
  'playedAt', 'playedAtSource', 'problems', 'robot', 'rules', 'runs', 'timing',
]
