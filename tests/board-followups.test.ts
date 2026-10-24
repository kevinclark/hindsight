// Slice 10c: the pit-only row's wording, grey vs awaiting-clean, the denominator of "seen in", the ended next-event deferral's age
// limit, and the gate line once the event is over. Invented data (event TEST, robot "Test robot").
import { describe, expect, it } from 'vitest'
import { buildBoard, seenText, type BoardIssue } from '../src/board/model.ts'
import { parseSchedule } from '../src/tba/schedule.ts'
import type { BoardEvent, IssueEvent } from '../src/triage/history.ts'
import { BASE, RAW, ROBOT, input, match, session } from './helpers/board-scene.ts'

const A = 'power/brownout · test'
const RULE = 'power/brownout'
const iso = (min: number) => new Date(BASE + min * 60e3).toISOString()
const day = 86400e3
let seq = 0
const bl = (op: BoardEvent['op'], value: string, when: string, o: Partial<BoardEvent> = {}): BoardEvent => ({
  type: 'board', v: 1, key: A, robot: ROBOT, op, value, event: 'TEST', by: { device: 'dev-a', role: 'pit' }, seq: ++seq, when, ...o,
})
const quiet = (n: number) => match(n, { quiet: [RULE] })
const fired = (n: number) => match(n, { fires: [{ key: A, severity: 'error' }] })
const unchecked = (n: number) => match(n, { notChecked: [RULE] })
const pitRun = (min: number) => match(99, { fires: [{ key: A, severity: 'error' }], onField: false, offsetMin: min, label: `pit${min}` })
const issue = (b: ReturnType<typeof buildBoard>): BoardIssue => b.issues.find((i) => i.key === A)!

describe('a pit-run-only issue does not read "0 of N matches"', () => {
  it('counts the pit runs on the model and in the words', () => {
    const s = session([quiet(2), quiet(3), quiet(4)], [pitRun(500), pitRun(520)])
    const i = issue(buildBoard(input(s)))
    expect(i.seenIn).toEqual({ n: 0, of: 0, pit: 2 })
    expect(seenText(i.seenIn)).toBe('Seen in 2 pit runs (no match)')
  })
  it('one pit run is singular', () => expect(seenText({ n: 0, of: 0, pit: 1 })).toBe('Seen in 1 pit run (no match)'))
  it('matches and pit runs together append the pit count', () => {
    const s = session([quiet(2), fired(3), fired(4), quiet(5)], [pitRun(500)])
    const i = issue(buildBoard(input(s)))
    expect(i.seenIn).toEqual({ n: 2, of: 4, pit: 1 })
    expect(seenText(i.seenIn)).toBe('Seen in 2 of 4 matches and 1 pit run')
  })
  it('a match-only issue reads as before', () => expect(seenText({ n: 1, of: 1, pit: 0 })).toBe('Seen in 1 of 1 match'))
  it('the denominator is the merged finding\'s checkable count, never a pit-run fallback', () => {
    const i = issue(buildBoard(input(session([quiet(2), quiet(3)], [pitRun(500)]))))
    expect(i.seenIn.of).toBe(0)
  })
})

describe('a red closed by hand and waiting for its clean match is not grey', () => {
  it('awaitingClean excludes grey', () => {
    // Fired in Q2, fixed after Q2, the rule not checkable in Q3-Q5: status "check", unseen for 3 matches, unchanged for 3.
    const s = session([fired(2), unchecked(3), unchecked(4), unchecked(5)])
    const mark: IssueEvent = { type: 'issue', key: A, status: 'fixed', note: 'test reason', when: iso(2 * 20 + 5), match: 'TEST Qualification 2', event: 'TEST', played: iso(40) }
    const i = issue(buildBoard(input(s, [mark])))
    expect(i.status).toBe('check')
    expect(i.awaitingClean).toBe(true)
    expect(i.grey).toBe(false)
    expect(i.greyAsk).toBeNull()
  })
  it('an untouched old issue is still grey', () => {
    const i = issue(buildBoard(input(session([fired(2), quiet(3), quiet(4), quiet(5)]))))
    expect(i).toMatchObject({ grey: true, awaitingClean: false })
  })
})

describe('an ended next-event deferral is shown only when recent and datable', () => {
  const live = session([quiet(2), quiet(3), fired(4), fired(5)])
  const defer = (o: Partial<BoardEvent>) => [bl('workaround', 'test workaround', iso(1), { event: 'OTHER', ...o }), bl('defer', 'next-event', iso(1), { event: 'OTHER', until: { kind: 'next-event' }, ...o })]
  const deferral = (lines: BoardEvent[]) => issue(buildBoard(input(live, lines))).deferral
  it('an event name and a played time 30 days before the session: shown as ended', () => {
    expect(deferral(defer({ played: new Date(BASE + 40 * 60e3 - 30 * day).toISOString() }))).toMatchObject({ expired: true, workaround: 'test workaround' })
  })
  it('119 days before shows, 121 days before is dropped', () => {
    expect(deferral(defer({ played: new Date(BASE + 40 * 60e3 - 119 * day).toISOString() }))).not.toBeNull()
    expect(deferral(defer({ played: new Date(BASE + 40 * 60e3 - 121 * day).toISOString() }))).toBeNull()
  })
  it('a deferral carrying neither event nor played is dropped', () => {
    expect(deferral(defer({ event: undefined, played: undefined }))).toBeNull()
  })
  it('an event name alone is dated by when it was written', () => {
    expect(deferral(defer({ when: new Date(BASE - 10 * day).toISOString() }))).not.toBeNull()
    expect(deferral(defer({ when: new Date(BASE - 200 * day).toISOString() }))).toBeNull()
  })
  it('a played time with no event name counts too', () => {
    expect(deferral(defer({ event: undefined, played: new Date(BASE - 10 * day).toISOString() }))).not.toBeNull()
  })
})

describe('the gate line once the event is over', () => {
  const s = session([quiet(2), quiet(3), fired(4), fired(5)])
  const done = parseSchedule(RAW.slice(0, 4) as never)
  it('with a schedule and no match left, strip.over is set and the gate still counts the open reds', () => {
    const b = buildBoard(input(s, [], done))
    expect(b.strip.over).toBe(true)
    expect(b.strip.gate).toBe(1)
  })
  it('with a next match it is not over; with no schedule it is not over either', () => {
    expect(buildBoard(input(s)).strip.over).toBe(false)
    expect(buildBoard(input(s, [], null)).strip.over).toBe(false)
  })
})
