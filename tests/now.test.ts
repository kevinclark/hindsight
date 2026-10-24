// Now (ADR 10): the state and tasks for this moment. Everything here is invented: event TEST, robot "Test robot", a made-up
// schedule (tests/helpers/board-scene.ts); no real match, team or verdict.
import { describe, expect, it } from 'vitest'
import { buildBoard } from '../src/board/model.ts'
import { eventSessionFor, latestStarted, newestRobot, nowState, redsDue, robotNotFound, stillSession, type NowInput } from '../src/now/now.ts'
import { todayMode } from '../src/session/mode.ts'
import { BASE, SCHEDULE, input, match, session } from './helpers/board-scene.ts'
import { dateText } from '../src/session/day.ts'

const min = (m: number) => BASE + m * 60e3
const at = (ms: number) => new Date(ms).toISOString().slice(11, 16) // "17:50": a clock that does not depend on the laptop's locale
const red = (n: number, keys: string[]) => match(n, { fires: keys.map((k) => ({ key: `power/brownout · ${k}`, severity: 'error' as const })) })
const boardOf = (s: ReturnType<typeof session>, now: number, schedule: typeof SCHEDULE | null = SCHEDULE) => buildBoard({ ...input(s, [], schedule), now: new Date(now) })

/** A hub or page Now for an event day with the schedule. Q4 started 20 min before `now`, Q5 starts 55 min after. */
function eventNow(over: Partial<NowInput> = {}, matches = [match(2), match(3)], now = min(200)): ReturnType<typeof nowState> {
  const s = session(matches)
  return nowState({
    build: 'hub', mode: 'event', hasLogs: true, libraryToday: 4, event: boardOf(s, now), have: { team: true, key: true }, scheduleNote: null, still: null, now, clockText: at, ...over,
  })
}
const task = (st: ReturnType<typeof nowState>, id: string) => st.tasks.find((t) => t.id === id)!

describe('Now on an event day with the schedule', () => {
  it('says the next match, its time and the minutes left; tasks run pull, triage, queue check', () => {
    const st = eventNow()
    expect(st.kind).toBe('event')
    expect(st.big).toBe(`Next match: Q5 at ${at(min(255))} · in 55 min`)
    expect(st.tasks.map((t) => t.id)).toEqual(['pull', 'triage', 'queue'])
    expect(st.keyLine).toBeNull()
    expect(st.also.map((a) => a.text)).toEqual(['check one match'])
    expect(st.modeLine).toBe(true)
  })
  it('leaves the minutes out when the start is not within the timeline window, and the time when there is none', () => {
    expect(eventNow({}, [match(2), match(3)], min(200) - 3 * 24 * 60 * 60e3).big).toBe(`Next match: Q4 at ${at(min(180))}`)
    const noTimes = SCHEDULE.map((m) => ({ ...m, scheduled: null, predicted: null, actual: null }))
    const s = session([match(2), match(3)])
    const st = nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 0, event: boardOf(s, min(200), noTimes as never), have: { team: true, key: true }, scheduleNote: null, still: null, now: min(200), clockText: at })
    expect(st.big).toBe('Next match: Q4')
  })
  it('the pull task names the latest match that has started, until its log is the session\'s latest', () => {
    const pull = task(eventNow(), 'pull')
    expect(pull).toMatchObject({ title: "Pull Q4's log", done: false, button: 'Pull from the robot', action: { kind: 'pull' }, primary: true })
    expect(pull.detail).toBe('Q4 started 20 min ago. Plug in the USB cable, then Pull.')
  })
  it('the pull task reads done, muted and without a button, once that log is in', () => {
    const done = task(eventNow({}, [match(2), match(3), match(4)]), 'pull')
    expect(done).toMatchObject({ title: "Q4's log is in", done: true, button: null, action: null, primary: false, detail: '' })
  })
  it('triage counts the reds due before the next match: none, and three', () => {
    const none = task(eventNow(), 'triage')
    expect(none).toMatchObject({ title: 'Triage before Q5', detail: 'No reds due before Q5', button: 'Open the board', action: { kind: 'board' } })
    const matches = [red(2, ['a', 'b', 'c']), red(3, ['a', 'b', 'c'])]
    const board = boardOf(session(matches), min(200))
    expect(redsDue(board)).toBe(3)
    const three = task(eventNow({}, matches), 'triage')
    expect(three.detail).toBe('3 reds due before Q5')
    expect(task(eventNow({}, [red(2, ['a']), red(3, ['a'])]), 'triage').detail).toBe('1 red due before Q5')
  })
  it('the queue check names the next match and goes to Foresight', () => {
    expect(task(eventNow(), 'queue')).toMatchObject({ title: 'Queue check for Q5', button: 'Start the queue check', action: { kind: 'go', place: 'foresight' } })
  })
  it('names the next match that has not started, even before the last match\'s log is in', () => {
    // Q3 is the latest log, Q4 and Q5 have both started (two logs missed): the next is Q6, and the pull is for Q5.
    const st = eventNow({}, [match(2), match(3)], min(270))
    expect(st.big).toBe(`Next match: Q6 at ${at(min(310))} · in 40 min`)
    expect(task(st, 'pull').title).toBe("Pull Q5's log")
    expect(task(st, 'queue').title).toBe('Queue check for Q6')
  })
  it('with no match left on the schedule, says so', () => {
    const s = session([match(2), match(3)])
    const only = SCHEDULE.slice(0, 2)
    const st = nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 2, event: boardOf(s, min(200), only), have: { team: true, key: true }, scheduleNote: null, still: null, now: min(200), clockText: at })
    expect(st.big).toBe("Next match: none left on the team's schedule")
    expect(task(st, 'triage').title).toBe('Triage before the next match')
  })
  it('after the qualifications the next playoff match is named as the board names it', () => {
    const matches = [match(2), match(3), match(4), match(5), match(6), match(7), match(40), match(41)]
    expect(eventNow({}, matches, min(5000)).big).toMatch(/^Next match: SF4M1 at /)
  })
  it('the page swaps the pull for opening a log in Match review', () => {
    const st = eventNow({ build: 'page', libraryToday: null })
    expect(task(st, 'pull')).toMatchObject({ title: "Open Q4's log", button: 'Open a log…', action: { kind: 'open-log' } })
    expect(st.tasks.some((t) => t.action?.kind === 'pull')).toBe(false)
  })
  it('latestStarted is the highest qualification whose start has passed', () => {
    const tl = { starts: new Map<number, number | null>([[2, min(0)], [3, min(50)], [4, min(180)], [5, null]]) }
    expect(latestStarted(tl, min(60))?.qual).toBe(3)
    expect(latestStarted(tl, min(-5))).toBeNull()
  })
})

describe('Now on an event day with no schedule', () => {
  const noSchedule = (over: Partial<NowInput> = {}) => {
    const s = session([match(2), match(3)])
    return nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 2, event: boardOf(s, min(200), null), have: { team: true, key: false }, scheduleNote: null, still: null, now: min(200), clockText: at, ...over })
  }
  it('says the next match is not known yet and links to where the key is set, in the Library on the desktop app', () => {
    const st = noSchedule()
    expect(st.kind).toBe('event-no-schedule')
    expect(st.big).toBe('Next match: not known yet')
    expect(st.keyLine).toMatchObject({ lead: 'Add The Blue Alliance read key in', link: { text: 'the Library', action: { kind: 'go', place: 'library' } }, rest: ': it names the event and the schedule.' })
    expect(st.tasks.map((t) => t.title)).toEqual(["Pull the last match's log", 'Triage before the next match', 'Queue check for the next match'])
  })
  it('on the page the key is set in the Session view; a missing team number is named too', () => {
    const st = noSchedule({ build: 'page', libraryToday: null, have: { team: false, key: false } })
    expect(st.keyLine).toMatchObject({ lead: 'Add your team number and The Blue Alliance read key in', link: { text: 'the Session view', action: { kind: 'go', place: 'session' } } })
  })
  it('with the key and team set it shows why the schedule was not read instead', () => {
    const st = noSchedule({ have: { team: true, key: true }, scheduleNote: 'No schedule: test reason.' })
    expect(st.keyLine).toBeNull()
    expect(st.scheduleNote).toBe('No schedule: test reason.')
  })
})

describe('Now on an event day known only from the outside', () => {
  const outside = (over: Partial<NowInput> = {}) => nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 5, event: null, have: { team: true, key: true }, scheduleNote: null, still: null, now: min(200), clockText: at, ...over })
  it('offers to open today\'s logs on the board in place of the triage', () => {
    const st = outside()
    expect(st.kind).toBe('event-outside')
    expect(st.big).toBe('Next match: not known yet')
    expect(task(st, 'triage')).toMatchObject({ title: "Open today's logs on the board", detail: '5 logs from today in the library', button: 'Open the board', action: { kind: 'board' } })
    expect(task(st, 'pull').title).toBe("Pull the last match's log")
  })
  it('with no log from today in the library there is nothing to open: no button, and it says to pull one', () => {
    const t = task(outside({ libraryToday: 0 }), 'triage')
    expect(t.button).toBeNull()
    expect(t.detail).toMatch(/pull one first/)
  })
  it('on the page it goes to the Session view', () => {
    expect(task(outside({ build: 'page', libraryToday: null }), 'triage')).toMatchObject({ button: 'Open the Session view', action: { kind: 'go', place: 'session' } })
  })
})

describe('Now on a practice day', () => {
  const practice = (over: Partial<NowInput> = {}) => nowState({ build: 'hub', mode: 'practice', hasLogs: true, libraryToday: 3, event: null, have: { team: true, key: true }, scheduleNote: null, still: { event: 'Test Regional', open: 12, red: 5 }, now: min(200), clockText: at, ...over })
  it('start-of-practice check, today\'s runs, what is still open', () => {
    const st = practice()
    expect(st.kind).toBe('practice')
    expect(st.big).toBe(`Practice · ${dateText(min(200))}`)
    expect(st.tasks.map((t) => t.id)).toEqual(['practice-check', 'runs', 'still'])
    expect(task(st, 'practice-check')).toMatchObject({ title: 'Start-of-practice check', detail: 'in Foresight · about 5 min, robot on', button: 'Open Foresight', action: { kind: 'go', place: 'foresight' } })
    expect(task(st, 'runs')).toMatchObject({ title: "Pull today's runs", detail: '3 logs from today in the library. Plug in the USB cable, then Pull.', action: { kind: 'pull' } })
    expect(task(st, 'still')).toMatchObject({ title: "Still open: 12 issues on Test Regional's board", detail: '5 red', action: { kind: 'board' } })
  })
  it('says nothing is open when the board has nothing, and when there is no event board', () => {
    expect(task(practice({ still: { event: 'Test Regional', open: 0, red: 0 } }), 'still')).toMatchObject({ title: 'Nothing open', done: true })
    expect(task(practice({ still: null }), 'still')).toMatchObject({ title: 'Nothing open', detail: 'No event board yet.', button: null })
  })
  it('the page opens today\'s logs in the Session view instead of pulling', () => {
    const st = practice({ build: 'page', libraryToday: null })
    expect(task(st, 'runs')).toMatchObject({ title: "Open today's logs", action: { kind: 'open-logs' } })
    expect(st.tasks.some((t) => t.action?.kind === 'pull')).toBe(false)
  })
  it('with no log today the pull line has no count', () => {
    expect(task(practice({ libraryToday: 0 }), 'runs').detail).toBe('Plug in the USB cable, then Pull.')
  })
})

describe('Now with no logs', () => {
  const none = (build: 'hub' | 'page') => nowState({ build, mode: 'practice', hasLogs: false, libraryToday: build === 'hub' ? 0 : null, event: null, have: { team: false, key: false }, scheduleNote: null, still: null, now: min(0), clockText: at })
  it('the desktop app offers a log, a folder, and a pull, then one line per job with its place', () => {
    const st = none('hub')
    expect(st.kind).toBe('no-logs')
    expect(st.tasks.map((t) => [t.id, t.primary])).toEqual([['open-log', true], ['add-folder', false], ['pull-logs', false]])
    expect(st.jobs.map((j) => j.place)).toEqual(['Match review', 'Session › Board', 'Foresight', 'Library'])
    expect(st.modeLine).toBe(false)
  })
  it('the page swaps every hub-only task and the Library line for opening a log', () => {
    const st = none('page')
    expect(st.tasks.map((t) => t.id)).toEqual(['open-log'])
    expect(st.jobs.map((j) => j.place)).toEqual(['Match review', 'Session › Board', 'Foresight'])
  })
})

describe('which session is today\'s', () => {
  const day2 = min(24 * 60 + 600)
  it('the second morning, before any log of the day, still reads the event\'s session', () => {
    const s = session([match(2), match(3)])
    const today = todayMode([s], day2, {}, { id: 'event-days:2099test', name: 'Test Regional', key: '2099test', signal: 'tba' })
    expect(today.mode).toBe('event')
    expect(eventSessionFor([s], today.sessionId, { key: '2099test', name: 'Test Regional' }, day2)).toBe(s)
  })
  it('an earlier event\'s session is not today\'s', () => {
    const s = session([match(2), match(3)])
    expect(eventSessionFor([s], 'event-days:2099other', { key: '2099other', name: 'Other Regional' }, day2 + 30 * 24 * 60 * 60e3)).toBeNull()
  })
  it('no session, no robot', () => {
    expect(newestRobot([])).toBeNull()
    expect(eventSessionFor([], 'x', null, 0)).toBeNull()
    expect(stillSession([], 'x')).toBeNull()
  })
  it('a practice day reads the latest event session for the newest log\'s robot', () => {
    const s = session([match(2), match(3)])
    const got = stillSession([s], 'practice:2099-03-20')
    expect(got?.session).toBe(s)
    expect(got?.name).toBe('TEST')
  })
})

describe('a refused pull', () => {
  it('tells "the robot did not answer" from "it answered and said no"', () => {
    expect(robotNotFound('Could not check the robot: connection refused')).toBe(true)
    expect(robotNotFound('The robot did not say whether it is disabled and off the field, so nothing was pulled.')).toBe(true)
    expect(robotNotFound('The robot is enabled. Disable it before pulling logs.')).toBe(false)
    expect(robotNotFound('The robot is on the field (FMS attached). Logs are not pulled on the field.')).toBe(false)
  })
})
