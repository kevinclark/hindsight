import { describe, expect, it } from 'vitest'
import { boardKey, boardState, lastPassingSha, mergeHistory, parseHistory, serializeHistory, triage, type BoardEvent, type HistoryEvent, type IssueEvent, type PitCheckEvent } from '../src/triage/history.ts'
import { DEVICE_ID_KEY, deviceId } from '../src/triage/device-id.ts'

const KEY = 'mech/follower-mismatch · Flywheel'
const issue = (status: IssueEvent['status'], when: string, extra: Partial<IssueEvent> = {}): IssueEvent => ({ type: 'issue', key: KEY, status, note: 'test reason', when, ...extra })
const pit: PitCheckEvent = { type: 'pit-check', verdict: 'GO', sha: 'abc123', dirty: false, robot: 'test robot', when: '2026-10-17T20:00:00Z' }
// All six kinds, on distinct timestamps, in time order.
const OLD: HistoryEvent[] = [
  pit,
  issue('known', '2026-10-17T21:00:00Z'),
  issue('wrong', '2026-10-17T21:10:00Z', { match: 'TEST Q1' }),
  issue('real', '2026-10-17T21:20:00Z', { match: 'TEST Q2', event: 'TEST', played: '2026-10-17T21:00:00Z' }),
  issue('unmark', '2026-10-17T21:30:00Z', { match: 'TEST Q1' }),
  issue('fixed', '2026-10-17T22:00:00Z'),
  { ...issue('new', '2026-10-17T23:00:00Z'), key: 'other/rule · Arm' },
  issue('known', '2026-10-18T01:00:00Z', { key: 'other/rule · Arm' }),
]

const board = (op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key: KEY, robot: 'test-robot', op, value, by: { device: 'dev-a', role: 'software' }, seq: 1, when, ...o,
})
const snapshot = (events: HistoryEvent[]) => {
  const t = triage(events)
  return JSON.stringify({ issues: [...t.issues], wrong: [...t.wrong], real: [...t.real], sha: lastPassingSha(events) })
}

describe('issue record v2: board lines', () => {
  it('the six existing kinds and pit-check fold the same before and after board lines are added', () => {
    const before = snapshot(OLD)
    const withBoard = [...OLD, board('priority', 'high', '2026-10-17T21:15:00Z'), board('note', 'test reason', '2026-10-18T02:00:00Z')]
    expect(snapshot(withBoard)).toBe(before)
    // The fixture really exercises every kind: known, fixed, wrong->unmark, real, new.
    const t = triage(OLD)
    expect(t.issues.get(KEY)?.status).toBe('fixed')
    expect(t.real.size).toBe(1)
    expect(t.wrong.size).toBe(0)
    expect(t.issues.get('other/rule · Arm')?.status).toBe('known')
  })

  it('an old-format file with board lines appended still folds the old kinds identically, and old builds would skip the board lines', () => {
    const oldText = serializeHistory(OLD)
    const appended = oldText + serializeHistory([board('status', 'fixing', '2026-10-19T00:00:00Z')])
    const parsed = parseHistory(appended)
    expect(parsed.skipped).toBe(0)
    expect(snapshot(parsed.events)).toBe(snapshot(parseHistory(oldText).events))
    // An old build's parser only accepts issue and pit-check; the board line is a different type, so it is skipped there.
    expect(parsed.events.filter((e) => e.type !== 'board')).toEqual(parseHistory(oldText).events)
  })

  it('round-trips every op through the file', () => {
    const lines: BoardEvent[] = [
      board('priority', 'low', '2026-10-20T00:00:01Z', { seq: 1 }),
      board('status', 'check', '2026-10-20T00:00:02Z', { seq: 2 }),
      board('defer', 'x', '2026-10-20T00:00:03Z', { seq: 3, until: { kind: 'gap', minutes: 30 } }),
      board('workaround', 'test reason', '2026-10-20T00:00:04Z', { seq: 4, match: 'TEST Q3', event: 'TEST', played: '2026-10-20T00:00:00Z', log: 'a'.repeat(64) }),
      board('note', 'test reason', '2026-10-20T00:00:05Z', { seq: 5 }),
    ]
    const r = parseHistory(serializeHistory(lines))
    expect(r.skipped).toBe(0)
    expect(r.events).toEqual(lines)
  })

  it('folds each op: latest priority, status, deferral, workaround; all notes in order; last by and when', () => {
    const other = { device: 'dev-b', role: 'pit' as const }
    const s = boardState([
      board('priority', 'low', '2026-10-20T00:00:01Z'),
      board('priority', 'high', '2026-10-20T00:00:02Z'),
      board('status', 'open', '2026-10-20T00:00:03Z'),
      board('status', 'fixing', '2026-10-20T00:00:04Z'),
      board('defer', 'x', '2026-10-20T00:00:05Z', { until: { kind: 'next-match', match: 'TEST Q9' } }),
      board('workaround', 'first', '2026-10-20T00:00:06Z'),
      board('workaround', 'second', '2026-10-20T00:00:07Z'),
      board('note', 'n1', '2026-10-20T00:00:08Z'),
      board('note', 'n2', '2026-10-20T00:00:09Z', { by: other, seq: 1 }),
    ]).get(boardKey(KEY, 'test-robot'))!
    expect(s.priority).toBe('high')
    expect(s.status).toBe('fixing')
    expect(s.deferred?.until).toEqual({ kind: 'next-match', match: 'TEST Q9' })
    expect(s.workaround).toBe('second')
    expect(s.notes.map((n) => n.text)).toEqual(['n1', 'n2'])
    expect(s.by).toEqual(other)
    expect(s.when).toBe('2026-10-20T00:00:09Z')
  })

  it('an empty defer clears the deferral', () => {
    const s = boardState([
      board('defer', 'x', '2026-10-20T00:00:01Z', { until: { kind: 'end-of-event' } }),
      board('defer', '', '2026-10-20T00:00:02Z'),
    ]).get(boardKey(KEY, 'test-robot'))!
    expect(s.deferred).toBeUndefined()
  })

  it('identity is key + robot: two robots keep separate state', () => {
    const m = boardState([board('priority', 'high', '2026-10-20T00:00:01Z'), board('priority', 'low', '2026-10-20T00:00:02Z', { robot: 'other-robot' }), board('priority', 'medium', '2026-10-20T00:00:03Z', { robot: '' })])
    expect(m.size).toBe(3)
    expect(m.get(boardKey(KEY, 'test-robot'))?.priority).toBe('high')
    expect(m.get(boardKey(KEY, 'other-robot'))?.priority).toBe('low')
    expect(m.get(boardKey(KEY, ''))?.priority).toBe('medium')
  })

  it('an old issue line (no robot) keeps applying to the key on any robot', () => {
    const events = [issue('known', '2026-10-20T00:00:01Z'), board('priority', 'high', '2026-10-20T00:00:02Z', { robot: 'other-robot' })]
    expect(triage(events).issues.get(KEY)?.status).toBe('known')
  })

  it('equal-when lines from two devices fold the same in both file orders', () => {
    const t = '2026-10-20T00:00:00Z'
    const a = board('priority', 'high', t, { by: { device: 'dev-a', role: 'software' }, seq: 7 })
    const b = board('priority', 'low', t, { by: { device: 'dev-b', role: 'pit' }, seq: 3 })
    const a2 = board('note', 'second from a', t, { by: { device: 'dev-a', role: 'software' }, seq: 8 })
    const a1 = board('note', 'first from a', t, { by: { device: 'dev-a', role: 'software' }, seq: 6 })
    const fold = (ev: HistoryEvent[]) => JSON.stringify([...boardState(ev)])
    expect(fold([a, b, a2, a1])).toBe(fold([a1, a2, b, a]))
    expect(fold([a, b])).toBe(fold([b, a]))
    expect(boardState([a, b]).get(boardKey(KEY, 'test-robot'))?.priority).toBe('low') // dev-b sorts after dev-a
    expect(boardState([a2, a1]).get(boardKey(KEY, 'test-robot'))?.notes.map((n) => n.text)).toEqual(['first from a', 'second from a'])
    // Same through mergeHistory.
    expect(mergeHistory([a, b], [a2, a1])).toEqual(mergeHistory([a1, b], [a2, a]))
  })

  it('equal-when old lines keep file order (nothing changes for files without board lines)', () => {
    const t = '2026-10-20T00:00:00Z'
    const k = issue('known', t)
    const f = issue('fixed', t)
    expect(triage([k, f]).issues.get(KEY)?.status).toBe('fixed')
    expect(triage([f, k]).issues.get(KEY)?.status).toBe('known')
    expect(mergeHistory([k], [f])).toEqual([k, f])
  })

  it('skips and counts a board line with a bad op, bad value, bad role or bad deferral', () => {
    const good = board('priority', 'high', '2026-10-20T00:00:01Z')
    const bad = [
      { ...good, op: 'close' },
      { ...good, value: 'urgent' },
      { ...good, by: { device: 'dev-a', role: 'boss' } },
      { ...good, op: 'defer', value: 'x', until: { kind: 'someday' } },
      { ...good, v: 2 },
      { ...good, seq: 'one' },
    ]
    const r = parseHistory([good, ...bad].map((e) => JSON.stringify(e)).join('\n'))
    expect(r.events).toEqual([good])
    expect(r.skipped).toBe(bad.length)
  })
})

describe('device id', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  it('is made on first use, kept under its own key, and reused', () => {
    const s = memory()
    let n = 0
    const first = deviceId(s, () => `id-${++n}`)
    expect(first).toBe('id-1')
    expect(s.m.get(DEVICE_ID_KEY)).toBe('id-1')
    expect(deviceId(s, () => `id-${++n}`)).toBe('id-1')
    expect(n).toBe(1)
  })
  it('the default id is random and not a hostname', () => {
    const a = deviceId(memory()), b = deviceId(memory())
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })
})
