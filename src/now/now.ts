/**
 * The Now screen's model (ADR 10): one state for this moment, and the tasks in order, each one button. Pure: the sessions, the
 * board as the Session view builds it (`buildBoard`, never a second board model), today's mode and `now` come in; nothing
 * here reads the clock, the page or the network, and nothing probes the robot (Now never says it is, or is not, connected).
 *
 * States: an event day with the schedule (`event`), an event day with no schedule (`event-no-schedule`), an event day known
 * only from the outside signal with no session of it loaded (`event-outside`), a practice day (`practice`), and no logs at all
 * (`no-logs`).
 */
import { isGate, robotOf, type Board } from '../board/model.ts'
import { minutesFromNow, posOf, scheduleLabel } from '../board/points.ts'
import { startOf, type ScheduledMatch } from '../tba/schedule.ts'
import { deferralSession, isCarried, sessionEventName } from '../foresight/checklists.ts'
import { dateText } from '../session/day.ts'
import type { Mode } from '../session/mode.ts'
import type { Session } from '../session/session.ts'
import type { TodayEvent } from '../session/today-event.ts'

export type Place = 'review' | 'session' | 'foresight' | 'library'

/** What a button or link does. The view knows how; the model only says which. */
export type NowAction =
  | { kind: 'go'; place: Place }
  | { kind: 'pull' }
  | { kind: 'open-log' }
  | { kind: 'open-logs' }
  | { kind: 'add-folder' }
  /** The Session view's board, with today's library logs (re)loaded first on the desktop app; `latest`: the newest event's logs instead (a practice day). */
  | { kind: 'board'; which?: 'today' | 'latest' }

export interface NowTask {
  id: 'pull' | 'triage' | 'queue' | 'practice-check' | 'runs' | 'still' | 'open-log' | 'add-folder' | 'pull-logs'
  title: string
  /** One line under the title; empty for a task that is done. */
  detail: string
  /** The task is finished: the view mutes it and gives it no button. */
  done: boolean
  /** The button; null for a task that is done or has nothing to press. */
  button: string | null
  action: NowAction | null
  /** The first thing to do (the heavy button); the rest are plain. */
  primary: boolean
}

export interface NowLink { text: string; action: NowAction }

export type NowKind = 'event' | 'event-no-schedule' | 'event-outside' | 'practice' | 'no-logs'

export interface NowState {
  kind: NowKind
  /** The big line. */
  big: string
  /** Under the big line, where the read key is set: "Add The Blue Alliance read key in [the Library]: it names the event and the schedule." */
  keyLine: { lead: string; link: NowLink; rest: string } | null
  /** Why no schedule was read, when the key and team are both set. */
  scheduleNote: string | null
  tasks: NowTask[]
  /** "Also:" links under the tasks. */
  also: NowLink[]
  /** No logs only: one line per job, each naming its place. */
  jobs: { job: string; place: string; action: NowAction }[]
  /** Whether the mode line is shown (the states that have a day). */
  modeLine: boolean
}

export interface NowInput {
  build: 'hub' | 'page'
  /** Today's mode (`todayMode`). */
  mode: Mode
  /** The library holds a log (hub), or a log is open or a session loaded (page). */
  hasLogs: boolean
  /** Hub: logs in the library dated today (not stubs); null on the page. */
  libraryToday: number | null
  /** Today's event session's board, or null when no session of today's event is loaded. */
  event: Pick<Board, 'tl' | 'rows'> | null
  /** What is missing for the schedule: the team number and the read key. */
  have: { team: boolean; key: boolean }
  /** Why the schedule could not be read (`sessionSchedule`'s note), when it could not. */
  scheduleNote: string | null
  /** The team's schedule the board was built with (null: none was read). */
  schedule?: readonly ScheduledMatch[] | null
  /** Hub: the library holds on-field logs, so an earlier event's board can be opened. */
  earlierEvent?: boolean
  /** Practice day: the latest event's board, as `deferralSession` picks it. */
  still: { event: string; open: number; red: number } | null
  now: number
  /** The clock time of a start ("3:35 PM"). Injected so a test does not depend on the laptop's locale. */
  clockText?: (ms: number) => string
}

const defaultClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const go = (place: Place): NowAction => ({ kind: 'go', place })

/** The reds due before the next match: the board's gate, the number the queue sheet counts. */
export const redsDue = (board: Pick<Board, 'tl' | 'rows'>): number => board.rows.filter((i) => isGate(i, board.tl)).length

/**
 * The reds due before a match at position `pos` (src/board/points.ts), as the board would place them if that match were next:
 * an undeferred red is due at the next match, a deferred one when its point comes up. The board's own rows and points, no second model.
 */
export function redsDueBefore(board: Pick<Board, 'rows'>, pos: number): number {
  const before = pos - 0.5
  return board.rows.filter((i) => i.open && i.priority === 'red' && !i.grey && !i.awaitingClean && (i.status === 'deferred' ? !!i.deferral && i.deferral.point.pos < before : i.due.pos <= before)).length
}

/**
 * When a scheduled match counts as started: The Blue Alliance has an actual time for it that has passed, or (only when the whole
 * schedule carries no actual time, an offline copy) its planned start has. A late-running event's planned start is not a start.
 */
export function startedAt(m: ScheduledMatch, schedule: readonly ScheduledMatch[], now: number): number | null {
  if (m.actual !== null) return m.actual <= now ? m.actual : null
  if (schedule.some((x) => x.actual !== null)) return null
  const t = startOf(m)
  return t !== null && t <= now ? t : null
}

/** The latest scheduled match (in play order) that has started. */
export function latestStarted(schedule: readonly ScheduledMatch[], now: number): { match: ScheduledMatch; at: number } | null {
  let best: { match: ScheduledMatch; at: number } | null = null
  for (const m of schedule) { const at = startedAt(m, schedule, now); if (at !== null) best = { match: m, at } }
  return best
}

/**
 * The next match that has not started, qualification or playoff, straight from the schedule. The board's `tl.next` is the first match
 * after the latest log, so until the last match's log is pulled it can be one already played. Null: none left. `from`: the
 * board's next position, as a floor: once a match's log is in, that match is not next even when the schedule copy has no actual
 * time for it yet (The Blue Alliance posts actuals late, and a copy can be minutes old).
 */
export function upcoming(schedule: readonly ScheduledMatch[], now: number, from = 0): { label: string; startsAt: number | null; leftMinutes: number | null; pos: number } | null {
  const m = schedule.find((x) => posOf(x, schedule) >= from && startedAt(x, schedule, now) === null)
  if (!m) return null
  const startsAt = startOf(m)
  return { label: scheduleLabel(m), startsAt, leftMinutes: minutesFromNow(startsAt, now, 2 * 1440), pos: posOf(m, schedule) }
}

function pullTask(input: NowInput, board: Pick<Board, 'tl'> | null, vague: string): NowTask {
  const hub = input.build === 'hub'
  const schedule = board?.tl.hasSchedule ? input.schedule ?? null : null
  const started = schedule ? latestStarted(schedule, input.now) : null
  const last = board?.tl.last ?? null
  // In when its log is the session's latest: a qualification by number, or any log played after the match began (a playoff match, or a late log).
  const done = !!started && !!last && ((last.playedAt !== null && last.playedAt > started.at) || (started.match.level === 'qm' && last.qual !== null && last.qual >= started.match.number))
  const name = started ? scheduleLabel(started.match) : null
  // Named by the log that is in (it can be a later match than the schedule copy knows has started).
  if (done) return { id: 'pull', title: `${last.qual !== null && started.match.level === 'qm' && last.qual > started.match.number ? last.label : name}'s log is in`, detail: '', done: true, button: null, action: null, primary: false }
  const age = started ? Math.floor((input.now - started.at) / 60e3) : null
  const ago = name && age !== null && age >= 1 ? `${name} started ${age} min ago. ` : ''
  if (hub) {
    return { id: 'pull', title: name ? `Pull ${name}'s log` : vague, detail: `${ago}Plug in the USB cable, then Pull.`, done: false, button: 'Pull from the robot', action: { kind: 'pull' }, primary: true }
  }
  return { id: 'pull', title: name ? `Open ${name}'s log` : "Open the last match's log", detail: `${ago}Choose it; it opens in Match review.`, done: false, button: 'Open a log…', action: { kind: 'open-log' }, primary: true }
}

function keyLine(input: NowInput): NowState['keyLine'] {
  const missing = [input.have.team ? '' : 'your team number', input.have.key ? '' : 'The Blue Alliance read key'].filter(Boolean)
  if (missing.length === 0) return null
  // The read key is set in the Library's "Your team" box (desktop app), or in the Session view's fields (the page).
  const hub = input.build === 'hub'
  return { lead: `Add ${missing.join(' and ')} in`, link: { text: hub ? 'the Library' : 'the Session view', action: go(hub ? 'library' : 'session') }, rest: ': it names the event and the schedule.' }
}

const alsoMatch: NowLink = { text: 'check one match', action: go('review') }

/** The Now screen for this moment. */
export function nowState(input: NowInput): NowState {
  const hub = input.build === 'hub'
  const empty: Pick<NowState, 'keyLine' | 'scheduleNote' | 'also' | 'jobs' | 'modeLine'> = { keyLine: null, scheduleNote: null, also: [], jobs: [], modeLine: true }
  if (!input.hasLogs) {
    const tasks: NowTask[] = [
      { id: 'open-log', title: "Open one match's log", detail: 'a log file you already have, or drop it anywhere on this page', done: false, button: 'Open a log…', action: { kind: 'open-log' }, primary: true },
      ...(hub ? [
        { id: 'add-folder', title: 'Add a folder of logs', detail: 'from AdvantageScope or a USB stick', done: false, button: 'Add a folder…', action: { kind: 'add-folder' }, primary: false } satisfies NowTask,
        { id: 'pull-logs', title: 'Pull logs off the robot', detail: 'plug in the USB cable first', done: false, button: 'Pull logs', action: { kind: 'pull' }, primary: false } satisfies NowTask,
      ] : []),
    ]
    return {
      ...empty, kind: 'no-logs', big: 'Start with a robot log', tasks, modeLine: false,
      jobs: [
        { job: 'Read one match', place: 'Match review', action: go('review') },
        { job: "Track what's broken", place: 'Session › Board', action: go('session') },
        { job: 'Check the robot before a match', place: 'Robot check', action: go('foresight') },
        ...(hub ? [{ job: 'Keep every log', place: 'Library', action: go('library') }] : []),
      ],
    }
  }

  if (input.mode === 'practice') {
    const today = input.libraryToday
    const runs: NowTask = hub
      ? { id: 'runs', title: "Pull today's runs", detail: `${today ? `${plural(today, 'log')} from today in the library. ` : ''}Plug in the USB cable, then Pull.`, done: false, button: 'Pull from the robot', action: { kind: 'pull' }, primary: false }
      : { id: 'runs', title: "Open today's logs", detail: 'Choose them; they open in the Session view.', done: false, button: 'Open logs…', action: { kind: 'open-logs' }, primary: false }
    const s = input.still
    const still: NowTask = s && s.open > 0
      ? { id: 'still', title: `Still open: ${plural(s.open, 'issue')} on ${s.event}'s board`, detail: `${s.red ? `${s.red} red` : 'none red'} · in Session › Board`, done: false, button: 'Open the board', action: { kind: 'board' }, primary: false }
      : s ? { id: 'still', title: 'Nothing open', detail: `${s.event}'s board has no open issue · in Session › Board`, done: true, button: 'Open the board', action: { kind: 'board' }, primary: false }
      // No board was built: that is not an all-clear. The library may hold an earlier event's logs.
      : input.earlierEvent ? { id: 'still', title: 'Event board not opened yet', detail: "Loads the newest event's logs · in Session › Board", done: false, button: 'Open the board', action: { kind: 'board', which: 'latest' }, primary: false }
      : hub ? { id: 'still', title: 'No event board yet', detail: 'Logs from an event make one.', done: false, button: null, action: null, primary: false }
      : { id: 'still', title: 'Event board not opened yet', detail: "Choose an event's logs · in Session › Board", done: false, button: 'Open the Session view', action: go('session'), primary: false }
    return {
      ...empty, kind: 'practice', big: `Practice · ${dateText(input.now)}`,
      tasks: [
        { id: 'practice-check', title: 'Start-of-practice check', detail: 'in Robot check · about 5 min, robot on', done: false, button: 'Open Robot check', action: go('foresight'), primary: true },
        runs, still,
      ],
      also: [alsoMatch],
    }
  }

  // An event day.
  const board = input.event
  const tl = board?.tl ?? null
  const kind: NowKind = !board ? 'event-outside' : tl!.hasSchedule ? 'event' : 'event-no-schedule'
  const next = tl && kind === 'event' && input.schedule ? upcoming(input.schedule, input.now, tl.next?.pos ?? 0) : null
  // No schedule, but a match number typed on this laptop: the board's timeline carries it as its next match (src/board/typed-next.ts).
  const typed = kind === 'event-no-schedule' && tl?.next ? tl.next : null
  const matchName = next?.label ?? typed?.label ?? 'the next match'
  const clock = input.clockText ?? defaultClock
  let big = typed ? `Next match: ${typed.label}` : 'Next match: not known yet'
  if (kind === 'event') {
    if (next) big = `Next match: ${next.label}${next.startsAt !== null ? ` at ${clock(next.startsAt)}` : ''}${next.leftMinutes !== null ? ` · in ${next.leftMinutes} min` : ''}`
    else if (input.schedule?.length) big = 'Next match: none left on the team\'s schedule'
  }
  const queue: NowTask = { id: 'queue', title: `Queue check for ${matchName}`, detail: 'Robot tethered, Driver Station connected, then Connect · in Robot check', done: false, button: 'Start the queue check', action: go('foresight'), primary: false }
  let triage: NowTask
  if (!board) {
    const n = input.libraryToday
    const hubNone = hub && n === 0
    triage = {
      id: 'triage', title: "Open today's logs on the board",
      detail: hub ? (n ? `${plural(n, 'log')} from today in the library · opens the board: reds due before the next match` : 'No logs from today in the library yet: pull one first.') : "Choose today's logs in the Session view · in Session › Board",
      done: false, button: hubNone ? null : hub ? 'Open the board' : 'Open the Session view', action: hubNone ? null : hub ? { kind: 'board' } : go('session'), primary: false,
    }
  } else {
    // Count at the match Now names (the board's gate counts at its own next match, which can be one already played).
    const due = next ? redsDueBefore(board, next.pos) : redsDue(board)
    triage = {
      id: 'triage', title: `Triage before ${matchName}`,
      detail: `${due ? `${plural(due, 'red')} due before ${matchName}` : `No reds due before ${matchName}`} · in Session › Board`,
      done: false, button: 'Open the board', action: { kind: 'board' }, primary: false,
    }
  }
  return {
    kind, big,
    keyLine: kind === 'event' ? null : keyLine(input),
    scheduleNote: kind !== 'event' && input.have.team && input.have.key ? input.scheduleNote : null,
    tasks: [pullTask(input, board, "Pull the last match's log"), triage, queue],
    also: [alsoMatch], jobs: [], modeLine: true,
  }
}

/** The robot of the newest log in any session (the one Now reads "still open" for): its profile id as the board files it. */
export function newestRobot(sessions: readonly Session[]): string | null {
  let best: { at: number; robot: string } | null = null
  for (const s of sessions) for (const m of [...s.matches, ...(s.pitRuns ?? [])]) if (m.playedAt !== null && (!best || m.playedAt > best.at)) best = { at: m.playedAt, robot: robotOf(m) }
  return best?.robot ?? null
}

/**
 * Which session is today's event for Now: the one the mode line found, else (the second day, before any log of the day) the
 * latest event session for this robot that is not an earlier event's. Null: none loaded (the outside-signal state).
 * Foresight reads its deferral session the same way (`deferralSession`, `isCarried`).
 */
export function eventSessionFor(sessions: readonly Session[], todaySessionId: string, external: Pick<TodayEvent, 'key' | 'name'> | null, now: number): Session | null {
  const robot = newestRobot(sessions)
  if (!robot) return null
  const s = deferralSession(sessions, todaySessionId, robot)
  return s && !isCarried(s, todaySessionId, external, now) ? s : null
}

/** The latest event's session for the robot, for a practice day's "still open" line. */
export function stillSession(sessions: readonly Session[], todaySessionId: string): { session: Session; name: string } | null {
  const robot = newestRobot(sessions)
  if (!robot) return null
  const s = deferralSession(sessions, todaySessionId, robot)
  return s ? { session: s, name: sessionEventName(s) } : null
}
