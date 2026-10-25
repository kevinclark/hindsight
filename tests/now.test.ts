// Now (ADR 10): the state and tasks for this moment. Everything here is invented: event TEST, robot "Test robot", a made-up
// schedule (tests/helpers/board-scene.ts); no real match, team or verdict.
import { describe, expect, it } from 'vitest'
import { buildBoard } from '../src/board/model.ts'
import { eventSessionFor, latestStarted, newestRobot, nowState, redsDue, redsDueBefore, stillSession, upcoming, type NowInput } from '../src/now/now.ts'
import { notReached } from '../src/hub/robot-reach.ts'
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
    build: 'hub', mode: 'event', hasLogs: true, libraryToday: 4, event: boardOf(s, now), have: { team: true, key: true }, scheduleNote: null, still: null, now, clockText: at, schedule: SCHEDULE, ...over,
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
    expect(eventNow({}, [match(2), match(3)], min(200) - 3 * 24 * 60 * 60e3).big).toBe(`Next match: Q4 at ${at(min(180))}`) // Q2 and Q3's logs are in, so Q4 is the floor
    const noTimes = SCHEDULE.map((m) => ({ ...m, scheduled: null, predicted: null, actual: null }))
    const s = session([match(2), match(3)])
    const st = nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 0, event: boardOf(s, min(200), noTimes as never), schedule: noTimes as never, have: { team: true, key: true }, scheduleNote: null, still: null, now: min(200), clockText: at })
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
    expect(none).toMatchObject({ title: 'Triage before Q5', detail: 'No reds due before Q5 · in Session › Board', button: 'Open the board', action: { kind: 'board' } })
    const matches = [red(2, ['a', 'b', 'c']), red(3, ['a', 'b', 'c'])]
    const board = boardOf(session(matches), min(200))
    expect(redsDue(board)).toBe(3)
    const three = task(eventNow({}, matches), 'triage')
    expect(three.detail).toBe('3 reds due before Q5 · in Session › Board')
    expect(task(eventNow({}, [red(2, ['a']), red(3, ['a'])]), 'triage').detail).toBe('1 red due before Q5 · in Session › Board')
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
    const st = nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 2, event: boardOf(s, min(200), only), schedule: only, have: { team: true, key: true }, scheduleNote: null, still: null, now: min(200), clockText: at })
    expect(st.big).toBe("Next match: none left on the team's schedule")
    expect(task(st, 'triage').title).toBe('Triage before the next match')
  })
  it('after the qualifications the next playoff match is named as the board names it', () => {
    const matches = [match(2), match(3), match(4), match(5), match(6), match(7), match(40), match(41)]
    expect(eventNow({}, matches, min(1440 - 60 + 655 + 200 - 60)).big).toMatch(/^Next match: SF4M1 at /)
  })
  it('the page swaps the pull for opening a log in Match review', () => {
    const st = eventNow({ build: 'page', libraryToday: null })
    expect(task(st, 'pull')).toMatchObject({ title: "Open Q4's log", button: 'Open a log…', action: { kind: 'open-log' } })
    expect(st.tasks.some((t) => t.action?.kind === 'pull')).toBe(false)
  })
  it('latestStarted is the last scheduled match whose start has passed', () => {
    expect(latestStarted(SCHEDULE, min(60))?.match.number).toBe(3)
    expect(latestStarted(SCHEDULE, min(-5))).toBeNull()
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
    expect(task(st, 'triage')).toMatchObject({ title: "Open today's logs on the board", detail: '5 logs from today in the library · opens the board: reds due before the next match', button: 'Open the board', action: { kind: 'board' } })
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
    expect(task(st, 'still')).toMatchObject({ title: "Still open: 12 issues on Test Regional's board", detail: '5 red · in Session › Board', action: { kind: 'board' } })
  })
  it('says nothing is open when the board has nothing, and when there is no event board', () => {
    expect(task(practice({ still: { event: 'Test Regional', open: 0, red: 0 } }), 'still')).toMatchObject({ title: 'Nothing open', done: true })
    expect(task(practice({ still: null }), 'still')).toMatchObject({ title: 'No event board yet', button: null, done: false })
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
  it('"Robot not found" only when the socket never opened, on each message checkRobotIdle can produce', () => {
    expect(notReached('Could not reach the robot: Connection closed (code 1006)')).toBe(true)
    expect(notReached('Could not reach the robot: nothing answered at 172.22.11.2 within 8 s.')).toBe(true)
    expect(notReached('Could not check the robot: Connection closed (code 1006)')).toBe(false)
    expect(notReached('Could not check the robot: The robot sent no value saying whether the field is attached (…). Disconnected.')).toBe(false)
    expect(notReached('The robot did not say whether it is disabled and off the field, so nothing was pulled.')).toBe(false)
    expect(notReached('The robot is enabled. Disable it before pulling logs.')).toBe(false)
    expect(notReached('The robot is on the field (FMS attached). Logs are not pulled on the field.')).toBe(false)
    expect(notReached('This robot was on the field earlier in this run. Restart Hindsight before pulling logs in the pit.')).toBe(false)
    expect(notReached('Could not check the robot: protocol error')).toBe(false)
  })
})

describe('the fix pass', () => {
  const playoffLog = (offset: number) => ({ ...match(9, { offsetMin: offset }), matchLabel: 'Elimination 1', matchType: 3 })
  const SF = (1440 - 60 + 655 + 200) // minutes after BASE the semifinal is scheduled
  const quals = [2, 3, 4, 5, 6, 7, 40, 41].map((n) => match(n))
  it('1. playoffs: with a playoff log in, the pull is done and no qualification is asked for; before it the playoff match is next', () => {
    const now = min(SF + 30)
    const st = eventNow({}, [...quals, playoffLog(SF + 5)], now)
    expect(task(st, 'pull')).toMatchObject({ title: "SF4M1's log is in", done: true })
    expect(JSON.stringify(st.tasks)).not.toMatch(/Pull Q41/)
    // The qualifications are over and the semifinal is still ahead: the pull is for Q41, the next match is the playoff match.
    const before = eventNow({}, quals.slice(0, -1), min(SF - 60))
    expect(before.big).toMatch(/^Next match: SF4M1 at /)
    expect(task(before, 'pull').title).toBe("Pull Q41's log")
    expect(upcoming(SCHEDULE, min(SF - 60))?.label).toBe('SF4M1')
    expect(upcoming(SCHEDULE, min(SF + 30))).toBeNull()
  })
  it('2. the reds line counts at the match Now names: a red deferred to Q35 is due before Q40 though the board reads Q33 as next', () => {
    const base = boardOf(session([match(2), match(3)]), min(200))
    const row = (status: string, duePos: number, deferredPos?: number) => ({ open: true, priority: 'red', grey: false, awaitingClean: false, status, due: { pos: duePos }, deferral: deferredPos === undefined ? null : { point: { pos: deferredPos } } })
    const rows = [row('open', base.tl.nextPos), row('deferred', base.tl.nextPos, 34.5), row('deferred', base.tl.nextPos, 44.5)] as never
    expect(redsDue({ tl: base.tl, rows })).toBe(1) // the board's gate: deferred reds are not due
    expect(redsDueBefore({ rows }, 40)).toBe(2) // before Q40: the open red and the one deferred to Q35
    const sched = SCHEDULE.map((m) => (m.number <= 7 && m.level === 'qm' ? { ...m, actual: m.scheduled } : m))
    const st = eventNow({ schedule: sched, event: { tl: base.tl, rows } }, [match(2), match(3)], min(2000))
    expect(task(st, 'triage').title).toBe('Triage before Q40')
    expect(task(st, 'triage').detail).toBe('2 reds due before Q40 · in Session › Board')
  })
  it('3. a late-running event: a planned start with no actual time, while other matches have one, is not a start', () => {
    const sched = SCHEDULE.map((m) => (m.level === 'qm' && m.number <= 4 ? { ...m, actual: m.scheduled } : m))
    const st = eventNow({ schedule: sched }, [match(2), match(3)], min(270)) // Q5 was planned for min 255
    expect(task(st, 'pull').title).toBe("Pull Q4's log")
    expect(st.big).toMatch(/^Next match: Q5 at /)
    // An offline copy with no actual time at all falls back to the planned starts.
    expect(upcoming(SCHEDULE, min(270))?.label).toBe('Q6')
  })
  it('7. a practice day with no board built is not an all-clear', () => {
    const none = nowState({ build: 'hub', mode: 'practice', hasLogs: true, libraryToday: 0, event: null, have: { team: true, key: true }, scheduleNote: null, still: null, earlierEvent: true, now: min(0), clockText: at })
    expect(task(none, 'still')).toMatchObject({ title: 'Event board not opened yet', button: 'Open the board', action: { kind: 'board', which: 'latest' }, done: false })
    const page = nowState({ build: 'page', mode: 'practice', hasLogs: true, libraryToday: null, event: null, have: { team: true, key: true }, scheduleNote: null, still: null, now: min(0), clockText: at })
    expect(task(page, 'still')).toMatchObject({ title: 'Event board not opened yet', action: { kind: 'go', place: 'session' } })
    const built = nowState({ build: 'hub', mode: 'practice', hasLogs: true, libraryToday: 0, event: null, have: { team: true, key: true }, scheduleNote: null, still: { event: 'TEST', open: 0, red: 0 }, now: min(0), clockText: at })
    expect(task(built, 'still')).toMatchObject({ title: 'Nothing open', done: true })
  })
  it('8 and 9. each detail names where the button lands, and the outside state says what the click shows', () => {
    const st = eventNow()
    expect(task(st, 'queue').detail).toMatch(/in Foresight$/)
    expect(task(st, 'triage').detail).toMatch(/in Session › Board$/)
    expect(task(eventNow({ build: 'page', libraryToday: null }), 'pull').detail).toMatch(/opens in Match review/)
    const out = nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 37, event: null, have: { team: true, key: true }, scheduleNote: null, still: null, now: min(200), clockText: at })
    expect(task(out, 'triage').detail).toBe('37 logs from today in the library · opens the board: reds due before the next match')
  })
})

describe('the fix pass, verified', () => {
  it('a pulled log floors the next match even when the schedule copy has no actual time for it yet', () => {
    const sched = SCHEDULE.map((m) => (m.level === 'qm' && m.number <= 3 ? { ...m, actual: m.scheduled } : m))
    const s = session([red(2, ['a', 'b']), red(3, ['a', 'b']), red(4, ['a', 'b'])])
    const now = min(200)
    const board = buildBoard({ ...input(s, [], sched), now: new Date(now) })
    const st = nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 3, event: board, have: { team: true, key: true }, scheduleNote: null, still: null, now, clockText: at, schedule: sched })
    expect(board.tl.next?.label).toBe('Q5')
    expect(st.big).toMatch(/^Next match: Q5/)
    expect(st.tasks.find((t) => t.id === 'pull')).toMatchObject({ title: "Q4's log is in", done: true })
    expect(st.tasks.find((t) => t.id === 'triage')?.detail).toMatch(new RegExp(`^${redsDue(board)} reds due before Q5`))
  })
  it('counts the same reds as the board gate when Now and the board name the same match', () => {
    const base = buildBoard({ ...input(session([match(2), match(3)]), [], SCHEDULE), now: new Date(min(200)) })
    const rows = [
      { open: true, priority: 'red', grey: false, awaitingClean: false, status: 'open', due: { pos: base.tl.nextPos } },
      { open: true, priority: 'red', grey: false, awaitingClean: false, status: 'deferred', due: { pos: base.tl.nextPos }, deferral: { point: { pos: base.tl.nextPos } } },
    ] as never
    expect(redsDueBefore({ rows }, base.tl.next!.pos)).toBe(redsDue({ tl: base.tl, rows }))
  })
})

describe('a next match typed on this laptop (slice 2)', () => {
  it('names the typed match in the headline, the triage and the queue check when there is no schedule', () => {
    const s = session([red(2, ['a']), match(3)])
    const board = buildBoard({ ...input(s, [], null), now: new Date(min(200)), typedNext: 41 })
    const st = nowState({ build: 'hub', mode: 'event', hasLogs: true, libraryToday: 2, event: board, have: { team: true, key: false }, scheduleNote: null, still: null, now: min(200), clockText: at, schedule: null })
    expect(st.kind).toBe('event-no-schedule')
    expect(st.big).toBe('Next match: Q41')
    expect(st.tasks.find((t) => t.id === 'triage')?.title).toBe('Triage before Q41')
    expect(st.tasks.find((t) => t.id === 'queue')?.title).toBe('Queue check for Q41')
  })
})
