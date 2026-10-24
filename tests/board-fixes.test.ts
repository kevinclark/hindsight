// The fix pass on the board model: event scope for ticks and deferrals, same-match tie-breaks, a closed grey red outside the gate,
// time left from now, un-ticks, deferral expiry. Invented data (event TEST, robot "Test robot").
import { describe, expect, it } from 'vitest'
import { buildBoard, type BoardIssue } from '../src/board/model.ts'
import { suggestions, timeline } from '../src/board/points.ts'
import { queueSheet } from '../src/board/sheets.ts'
import { atLatest, boardLines, greyClose } from '../src/board/writes.ts'
import type { BoardEvent, HistoryEvent, IssueEvent } from '../src/triage/history.ts'
import { boardState, boardKey, parseHistory, serializeHistory } from '../src/triage/history.ts'
import { shortMatchLabel } from '../src/ui/match-label.ts'
import { BASE, ROBOT, SCHEDULE, input, match, session } from './helpers/board-scene.ts'

const A = 'power/brownout · test'
const RULE = 'power/brownout'
const iso = (min: number) => new Date(BASE + min * 60e3).toISOString()
const ref = (n: number) => ({ match: `TEST Qualification ${n}`, event: 'TEST', played: iso(n * 20) })
const after = (n: number) => iso(n * 20 + 5)
let seq = 0
const bl = (op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key: A, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})
const quiet = (n: number) => match(n, { quiet: [RULE] })
const fired = (n: number) => match(n, { fires: [{ key: A, severity: 'error' }] })
const issue = (b: ReturnType<typeof buildBoard>): BoardIssue => b.issues.find((i) => i.key === A)!
// A fires in Q4 and Q5 (a red due before the next match).
const live = session([quiet(2), quiet(3), fired(4), fired(5)])
// A fired only in Q2: grey by Q5.
const grey = session([fired(2), quiet(3), quiet(4), quiet(5)])

describe('ticks and deferrals belong to their event', () => {
  const tick = (o: Partial<BoardEvent> = {}) => bl('checked', 'Q6', after(5), { ...ref(5), ...o })
  const ticked = (lines: HistoryEvent[]) => issue(buildBoard(input(live, lines))).checked.length
  it('a tick counts when its event is the FMS event name', () => expect(ticked([tick()])).toBe(1))
  it('a tick of another event does not count, even for the same match label and a played time inside the span', () => {
    expect(ticked([tick({ event: 'OTHER', match: 'OTHER Qualification 5' })])).toBe(0)
    expect(queueSheet(buildBoard(input(live, [tick({ event: 'OTHER' })]))).toConfirm).toBe(1)
  })
  it('with no event named, a tick counts when its played time is inside the session\'s first to last match, else not', () => {
    expect(ticked([tick({ event: undefined })])).toBe(1)
    expect(ticked([tick({ event: undefined, played: iso(5000) })])).toBe(0)
    expect(ticked([tick({ event: undefined, played: undefined })])).toBe(0)
  })
  it('a deferral of another event does not defer the issue; status and notes still carry across', () => {
    const lines = [bl('workaround', 'test workaround', iso(1), { event: 'OTHER' }), bl('defer', 'end-of-event', iso(1), { event: 'OTHER', until: { kind: 'end-of-event' } }), bl('note', 'test reason', iso(2), { event: 'OTHER' }), bl('status', 'fixing', iso(3), { event: 'OTHER' })]
    const i = issue(buildBoard(input(live, lines)))
    expect(i.deferral).toBeNull()
    expect(i).toMatchObject({ status: 'fixing' })
    expect(i.notes).toHaveLength(1)
  })
  it('another event\'s "<event> Qualification 5" is not this event\'s Q5', () => {
    // The issue fired only in Q2, so it is grey; a note made on another event's Q5 must not count as a change at Q5.
    const other = bl('note', 'test reason', iso(1), { event: 'OTHER', match: 'OTHER Qualification 5' })
    expect(issue(buildBoard(input(grey, [other]))).grey).toBe(true)
    // The same note made on this event's Q5 does.
    expect(issue(buildBoard(input(grey, [bl('note', 'test reason', iso(1), ref(5))]))).grey).toBe(false)
  })
})

describe('a fixed mark and a status line on the same match', () => {
  const fixed = (when: string): IssueEvent => ({ type: 'issue', key: A, status: 'fixed', note: 'test reason', when, ...ref(3) })
  const session3 = session([fired(2), fired(3)])
  it('the later line wins: a status line written after the mark reopens it, one written before does not', () => {
    const afterMark = buildBoard(input(session3, [fixed(after(3)), bl('status', 'fixing', iso(3 * 20 + 9), ref(3))]))
    expect(issue(afterMark).status).toBe('fixing')
    const beforeMark = buildBoard(input(session3, [bl('status', 'fixing', iso(3 * 20 + 1), ref(3)), fixed(after(3))]))
    expect(issue(beforeMark).status).toBe('check')
  })
  it('two status lines at one moment from two devices fold in the order every laptop uses', () => {
    const t = after(3)
    const a = bl('status', 'check', t, { ...ref(3), by: { device: 'dev-a', role: 'pit' }, seq: 9 })
    const b = bl('status', 'open', t, { ...ref(3), by: { device: 'dev-b', role: 'pit' }, seq: 1 })
    const s = session([fired(2), fired(3), quiet(4)])
    expect(issue(buildBoard(input(s, [a, b]))).status).toBe(issue(buildBoard(input(s, [b, a]))).status)
    expect(issue(buildBoard(input(s, [a, b]))).status).toBe('open')
  })
})

describe('closing a grey red', () => {
  it('Close (status check) does not put it back in the gate or the queue verdict', () => {
    const lines = boardLines([], { device: 'dev-x', role: 'software' }, new Date(iso(300)), { key: A, robot: ROBOT }, greyClose(), atLatest(grey))
    const b = buildBoard(input(grey, lines))
    expect(issue(b)).toMatchObject({ status: 'check', grey: false, sinceSeen: 3 })
    expect(b.strip.gate).toBe(0)
    expect(queueSheet(b).verdict.text).toBe('GO WITH 0 DEFERRALS · 1 RED OPEN')
  })
  it('a red seen in the last match with status check is still in the gate', () => {
    const b = buildBoard(input(live, [bl('status', 'check', after(5), ref(5))]))
    expect(issue(b).sinceSeen).toBe(0)
    expect(b.strip.gate).toBe(1)
  })
})

describe('time left to the next match', () => {
  const next = BASE + 310 * 60e3
  it('counts from now when the start is near; otherwise says how long after the last match', () => {
    const near = buildBoard({ ...input(live), now: new Date(next - 61 * 60e3) })
    expect(near.strip.minutesWord).toBe('≈ 61 min left (est.)')
    expect(near.tl.next?.leftMinutes).toBe(61)
    const none = buildBoard(input(live))
    expect(none.strip.minutesWord).toBe('≈ 55 min after Q5 (est.)')
    const stale = buildBoard({ ...input(live), now: new Date(next + 3600e3) })
    expect(stale.strip.minutesWord).toBe('≈ 55 min after Q5 (est.)')
    const far = buildBoard({ ...input(live), now: new Date(next - 10 * 86400e3) })
    expect(far.strip.minutesWord).toBe('≈ 55 min after Q5 (est.)')
    expect(buildBoard(input(live, [], null)).strip.minutesWord).toBeNull()
  })
  it('the defer list gives each gap\'s start from now and its length', () => {
    const tl = timeline(live, SCHEDULE, (m) => shortMatchLabel(m.matchLabel, 0), next - 60 * 60e3)
    const s = suggestions(tl)
    expect(s[0].estimate).toBe('≈ 60 min from now, est.')
    // The overnight gap after Q7 starts when Q7 does (350 min after BASE), 40 minutes after Q6.
    expect(s[1].estimate).toBe('starts in ≈ 100 min, lasts ≈ 27 h 10 min, est.')
  })
})

describe('un-ticking', () => {
  const tick = (when: string, o: Partial<BoardEvent> = {}) => bl('checked', 'Q6', when, { ...ref(5), ...o })
  const untick = (when: string, o: Partial<BoardEvent> = {}) => bl('unchecked', 'Q6', when, { ...ref(5), ...o })
  it('a tick counts only if no later unchecked names its match; a later tick counts again', () => {
    const n = (lines: HistoryEvent[]) => issue(buildBoard(input(live, lines))).checked.length
    expect(n([tick(iso(1)), untick(iso(2))])).toBe(0)
    expect(n([tick(iso(1)), untick(iso(2)), tick(iso(3))])).toBe(1)
    expect(n([untick(iso(2)), tick(iso(3))])).toBe(1)
    expect(n([tick(iso(1)), untick(iso(2), { match: undefined, event: 'OTHER' })])).toBe(1)
  })
  it('the sheet is NOT CLEARED again after an un-tick', () => {
    expect(queueSheet(buildBoard(input(live, [tick(iso(1))]))).verdict.cleared).toBe(true)
    expect(queueSheet(buildBoard(input(live, [tick(iso(1)), untick(iso(2))]))).verdict.text).toBe('NOT CLEARED: 1 RED TO CONFIRM')
  })
  it('an unchecked line round-trips, needs a match, and an old build keeps it as an opaque line', () => {
    const line = untick(iso(2))
    expect(parseHistory(serializeHistory([line])).events).toEqual([line])
    expect(parseHistory(JSON.stringify({ ...line, value: '' })).events[0].type).toBe('opaque')
    const state = boardState([tick(iso(1)), untick(iso(2))]).get(boardKey(A, ROBOT))!
    expect(state.checked).toBeUndefined()
    expect(state.notes).toEqual([])
  })
})

describe('a deferral ends', () => {
  const defer = (until: BoardEvent['until'], when: string, o: Partial<BoardEvent> = {}) => [bl('workaround', 'test workaround', when, o), bl('defer', until!.kind, when, { until, ...o })]
  it('a next-match deferral that names no match ends once a match is played after it, with or without a schedule', () => {
    const madeAfterQ4 = defer({ kind: 'next-match' }, after(4), ref(4))
    expect(issue(buildBoard(input(live, madeAfterQ4))).deferral?.expired).toBe(true)
    expect(issue(buildBoard(input(live, madeAfterQ4, null))).deferral?.expired).toBe(true)
    const madeAfterQ5 = defer({ kind: 'next-match' }, after(5), ref(5))
    expect(issue(buildBoard(input(live, madeAfterQ5))).deferral?.expired).toBe(false)
    expect(issue(buildBoard(input(live, madeAfterQ5, null))).deferral?.expired).toBe(false)
  })
  it('with no schedule, a deferral whose point names Qn ends when the latest qualification has reached it', () => {
    const toQ5 = defer({ kind: 'next-match', match: 'Q5' }, iso(1), ref(2))
    expect(issue(buildBoard(input(live, toQ5, null))).deferral?.expired).toBe(true)
    const toQ9 = defer({ kind: 'next-match', match: 'Q9' }, iso(1), ref(2))
    expect(issue(buildBoard(input(live, toQ9, null))).deferral?.expired).toBe(false)
    // A gap after Q5 is live in the match after Q5 and over after the one after that.
    const gapQ5 = defer({ kind: 'gap', match: 'Q5' }, iso(1), ref(2))
    expect(issue(buildBoard(input(live, gapQ5, null))).deferral?.expired).toBe(false)
    expect(issue(buildBoard(input(session([quiet(2), quiet(3), fired(4), fired(5), fired(6)]), gapQ5, null))).deferral?.expired).toBe(true)
  })
})
