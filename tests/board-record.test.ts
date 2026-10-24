// The board's record (slice 10, commit A): the new `checked` and `owner` ops and the `event-note` line type. Old builds keep
// both as opaque lines and write them back unchanged; every older kind folds as it always did.
import { describe, expect, it } from 'vitest'
import {
  boardKey, boardState, boardStamp, compareEvents, eventNoteKey, eventNotes, lastPassingSha, mergeHistory, parseHistory, serializeHistory, triage,
  type BoardEvent, type EventNote, type HistoryEvent, type IssueEvent, type OpaqueEvent, type PitCheckEvent,
} from '../src/triage/history.ts'

const KEY = 'mech/follower-mismatch · Flywheel'
const issue = (status: IssueEvent['status'], when: string): IssueEvent => ({ type: 'issue', key: KEY, status, note: 'test reason', when })
const pit: PitCheckEvent = { type: 'pit-check', verdict: 'GO', sha: 'abc123', dirty: false, robot: 'test robot', when: '2099-03-05T17:00:00Z' }
const board = (op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key: KEY, robot: 'test-robot', op, value, by: { device: 'dev-a', role: 'pit' }, seq: 1, when, ...o,
})
const note = (kind: EventNote['kind'], text: string, when: string, o: Partial<EventNote> = {}): EventNote => ({
  type: 'event-note', v: 1, kind, event: 'TEST', match: 'Q5', text, by: { device: 'dev-a', role: 'pit' }, seq: 1, when, ...o,
})
const snapshot = (events: HistoryEvent[]) => {
  const t = triage(events)
  return JSON.stringify({ issues: [...t.issues], wrong: [...t.wrong], real: [...t.real], sha: lastPassingSha(events) })
}

describe('the checked op (a tick on the queue sheet)', () => {
  it('is a board line whose value is the match it was checked for', () => {
    const line = board('checked', 'Q41', '2099-03-05T18:00:00Z', { match: 'TEST Qualification 33' })
    const r = parseHistory(serializeHistory([line]))
    expect(r.events).toEqual([line])
    expect(parseHistory(JSON.stringify({ ...line, value: '' })).events[0].type).toBe('opaque')
  })
  it('is kept in boardState as a tick, never as a note, and is not a change to the issue', () => {
    const s = boardState([
      board('status', 'fixing', '2099-03-05T18:00:00Z', { seq: 1, match: 'TEST Qualification 28' }),
      board('checked', 'Q41', '2099-03-05T18:10:00Z', { seq: 2, by: { device: 'dev-b', role: 'drive' } }),
    ]).get(boardKey(KEY, 'test-robot'))!
    expect(s.checked).toEqual([{ match: 'Q41', by: { device: 'dev-b', role: 'drive' }, when: '2099-03-05T18:10:00Z' }])
    expect(s.notes).toEqual([])
    expect(s).toMatchObject({ status: 'fixing', match: 'TEST Qualification 28', when: '2099-03-05T18:00:00Z', by: { role: 'pit' } })
  })
  it('an issue with only ticks has no last change', () => {
    const s = boardState([board('checked', 'Q41', '2099-03-05T18:10:00Z')]).get(boardKey(KEY, 'test-robot'))!
    expect(s.changed).toBeUndefined()
  })
})

describe('the owner op', () => {
  it('sets a role, an empty value clears it, and a value that is not a role is kept unread', () => {
    const k = boardKey(KEY, 'test-robot')
    expect(boardState([board('owner', 'software', '2099-03-05T18:00:00Z')]).get(k)?.owner).toBe('software')
    expect(boardState([board('owner', 'software', '2099-03-05T18:00:00Z'), board('owner', '', '2099-03-05T18:01:00Z', { seq: 2 })]).get(k)?.owner).toBeUndefined()
    const r = parseHistory(JSON.stringify(board('owner', 'a person', '2099-03-05T18:00:00Z')))
    expect(r.events[0].type).toBe('opaque')
  })
})

describe('the event-note line', () => {
  it('round-trips each kind through the file', () => {
    const lines = [note('pit-change', 'test reason', '2099-03-05T18:00:01Z'), note('missed', 'test reason', '2099-03-05T18:00:02Z', { seq: 2 }), note('handoff-read', '', '2099-03-05T18:00:03Z', { seq: 3, match: '' })]
    const r = parseHistory(serializeHistory(lines))
    expect(r.skipped).toBe(0)
    expect(r.events).toEqual(lines)
  })
  it.each([
    ['an unknown kind', { kind: 'diary' }], ['a role that is not one', { by: { device: 'dev-a', role: 'boss' } }], ['a later version', { v: 2 }],
    ['a seq that is not a number', { seq: 'one' }], ['text that is not text', { text: 4 }],
  ])('keeps %s unread, as an opaque line', (_n, patch) => {
    const r = parseHistory(JSON.stringify({ ...note('missed', 'test reason', '2099-03-05T18:00:00Z'), ...patch }))
    expect(r.events.map((e) => e.type)).toEqual(['opaque'])
  })
  it('folds: the latest pit-change per match wins, an empty one clears it, missed and handoff reads are kept in order', () => {
    const f = eventNotes([
      note('pit-change', 'first', '2099-03-05T18:00:01Z', { seq: 1 }), note('pit-change', 'second', '2099-03-05T18:00:02Z', { seq: 2 }),
      note('pit-change', 'other', '2099-03-05T18:00:03Z', { seq: 3, match: 'Q6' }), note('pit-change', '', '2099-03-05T18:00:04Z', { seq: 4, match: 'Q6' }),
      note('missed', 'm1', '2099-03-05T18:00:05Z', { seq: 5 }), note('missed', 'm2', '2099-03-05T18:00:06Z', { seq: 6 }),
      note('handoff-read', '', '2099-03-05T18:00:07Z', { seq: 7 }),
    ])
    expect([...f.pitChange.keys()]).toEqual([eventNoteKey('TEST', 'Q5')])
    expect(f.pitChange.get(eventNoteKey('TEST', 'Q5'))!.text).toBe('second')
    expect(f.missed.map((n) => n.text)).toEqual(['m1', 'm2'])
    expect(f.handoffReads).toHaveLength(1)
  })
  it('equal-when lines from two devices fold the same in either file order', () => {
    const t = '2099-03-05T18:00:00Z'
    const a = note('pit-change', 'from a', t, { by: { device: 'dev-a', role: 'pit' }, seq: 9 })
    const b = note('pit-change', 'from b', t, { by: { device: 'dev-b', role: 'software' }, seq: 2 })
    const text = (ev: HistoryEvent[]) => [...eventNotes(ev).pitChange.values()].map((n) => n.text)
    expect(text([a, b])).toEqual(text([b, a]))
    expect(text([a, b])).toEqual(['from b'])
    expect(mergeHistory([a], [b])).toEqual(mergeHistory([b], [a]))
    expect(compareEvents(a, b)).toBeLessThan(0)
  })
})

describe('stamping', () => {
  it('seq is per device across board lines and event notes together; when never sorts before what the device has seen', () => {
    const h: HistoryEvent[] = [board('note', 'x', '2099-03-05T18:00:00Z', { seq: 4, by: { device: 'dev-a', role: 'pit' } }), note('missed', 'y', '2099-03-05T19:00:00Z', { seq: 6, by: { device: 'dev-a', role: 'pit' } }), note('missed', 'z', '2099-03-05T20:00:00Z', { seq: 20, by: { device: 'dev-b', role: 'pit' } })]
    const stamp = boardStamp(h, 'dev-a', new Date('2099-03-05T17:00:00Z'))
    expect(stamp.seq).toBe(7)
    expect(stamp.when).toBe('2099-03-05T20:00:00Z')
    expect(boardStamp(h, 'dev-c', new Date('2099-03-05T21:00:00Z'))).toEqual({ seq: 1, when: '2099-03-05T21:00:00.000Z' })
  })
})

describe('an old build', () => {
  // An old build types only issue, pit-check and the first five board ops. Every other well-formed line it keeps as an OpaqueEvent:
  // its raw text and its `when`, written back as it came (src/triage/history.ts parseHistory, the isObject fallback).
  const newLines = [
    JSON.stringify(board('checked', 'Q41', '2099-03-05T18:00:02Z', { seq: 2 })),
    JSON.stringify(board('owner', 'pit', '2099-03-05T18:00:03Z', { seq: 3 })),
    JSON.stringify(note('pit-change', 'test reason', '2099-03-05T18:00:04Z', { seq: 4 })),
    '{"type":"event-note",  "v":1,"kind":"missed","event":"TEST","match":"Q5","text":"test reason","by":{"device":"dev-a","role":"pit"},"seq":5,"when":"2099-03-05T18:00:05Z"}',
  ]
  const asOldBuildHoldsThem: OpaqueEvent[] = newLines.map((raw) => ({ type: 'opaque', raw, when: JSON.parse(raw).when }))
  const old: HistoryEvent[] = [pit, issue('known', '2099-03-05T17:10:00Z'), issue('fixed', '2099-03-05T17:20:00Z')]

  it('writes the new lines back byte for byte, between the lines it understands', () => {
    const text = `${serializeHistory(old)}${newLines.join('\n')}\n`
    const held = [...old, ...asOldBuildHoldsThem]
    expect(serializeHistory(held)).toBe(text)
    // And this build reads the same text into typed lines, and writes it back unchanged too (apart from key order of typed lines).
    const typed = parseHistory(text)
    expect(typed.skipped).toBe(0)
    expect(typed.events.map((e) => e.type)).toEqual(['pit-check', 'issue', 'issue', 'board', 'board', 'event-note', 'event-note'])
  })
  it('folds none of them: the old kinds fold exactly as with no new line, and no board state appears', () => {
    expect(snapshot([...old, ...asOldBuildHoldsThem])).toBe(snapshot(old))
    expect(boardState(asOldBuildHoldsThem).size).toBe(0)
    expect(eventNotes(asOldBuildHoldsThem).pitChange.size).toBe(0)
    // This build, with the new lines typed, folds the old kinds the same.
    expect(snapshot([...old, ...parseHistory(newLines.join('\n')).events])).toBe(snapshot(old))
  })
  it('merging a file with the new lines keeps them, once', () => {
    const merged = mergeHistory(old, asOldBuildHoldsThem)
    expect(merged.filter((e) => e.type === 'opaque')).toHaveLength(4)
    expect(mergeHistory(merged, asOldBuildHoldsThem)).toEqual(merged)
  })
})
