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
import { minutesFromNow } from '../board/points.ts'
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
  /** The Session view's board, with today's library logs (re)loaded first on the desktop app. */
  | { kind: 'board' }

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
  /** Practice day: the latest event's board, as `deferralSession` picks it. */
  still: { event: string; open: number; red: number } | null
  now: number
  /** The clock time of a start ("3:35 PM"). Injected so a test does not depend on the laptop's locale. */
  clockText?: (ms: number) => string
}

const defaultClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const plural = (n: number, one: string, many: string = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const go = (place: Place): NowAction => ({ kind: 'go', place })

/** The qualification the team's schedule says has started by `now` (the highest-numbered), or null. Playoff matches carry no start in the timeline. */
export function latestStarted(tl: Pick<Board['tl'], 'starts'>, now: number): { qual: number; startedAt: number } | null {
  let best: { qual: number; startedAt: number } | null = null
  for (const [qual, at] of tl.starts) if (at !== null && at <= now && (!best || qual > best.qual)) best = { qual, startedAt: at }
  return best
}

/** The reds due before the next match: the board's gate, the number the queue sheet counts. */
export const redsDue = (board: Pick<Board, 'tl' | 'rows'>): number => board.rows.filter((i) => isGate(i, board.tl)).length

/**
 * The next match that has not started. The board's `tl.next` is the first scheduled match after the latest log in the session, so
 * until the last match's log is pulled it can be a match that was already played; Now skips the qualifications that have started.
 */
export function upcoming(tl: Board['tl'], now: number): { label: string; startsAt: number | null; leftMinutes: number | null } | null {
  const next = tl.next
  if (!next) return null
  const started = latestStarted(tl, now)
  if (next.level !== 'qm' || !started || next.number > started.qual) return { label: next.label, startsAt: next.startsAt, leftMinutes: next.leftMinutes }
  const later = [...tl.starts.keys()].filter((n) => n > started.qual).sort((a, b) => a - b)[0]
  if (later === undefined) return null
  const startsAt = tl.starts.get(later) ?? null
  return { label: `Q${later}`, startsAt, leftMinutes: minutesFromNow(startsAt, now, 2 * 1440) }
}

function pullTask(input: NowInput, board: Pick<Board, 'tl'> | null, vague: string): NowTask {
  const hub = input.build === 'hub'
  const started = board?.tl.hasSchedule ? latestStarted(board.tl, input.now) : null
  const last = board?.tl.last?.qual ?? null
  const done = !!started && last !== null && last >= started.qual
  const name = started ? `Q${started.qual}` : null
  if (done) return { id: 'pull', title: `${name}'s log is in`, detail: '', done: true, button: null, action: null, primary: false }
  const age = started ? Math.floor((input.now - started.startedAt) / 60e3) : null
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
        { job: 'Check the robot before a match', place: 'Foresight', action: go('foresight') },
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
      ? { id: 'still', title: `Still open: ${plural(s.open, 'issue')} on ${s.event}'s board`, detail: s.red ? `${s.red} red` : 'none red', done: false, button: 'Open the board', action: { kind: 'board' }, primary: false }
      : { id: 'still', title: 'Nothing open', detail: s ? `${s.event}'s board has no open issue.` : 'No event board yet.', done: !!s, button: s ? 'Open the board' : null, action: s ? { kind: 'board' } : null, primary: false }
    return {
      ...empty, kind: 'practice', big: `Practice · ${dateText(input.now)}`,
      tasks: [
        { id: 'practice-check', title: 'Start-of-practice check', detail: 'in Foresight · about 5 min, robot on', done: false, button: 'Open Foresight', action: go('foresight'), primary: true },
        runs, still,
      ],
      also: [alsoMatch],
    }
  }

  // An event day.
  const board = input.event
  const tl = board?.tl ?? null
  const kind: NowKind = !board ? 'event-outside' : tl!.hasSchedule ? 'event' : 'event-no-schedule'
  const next = tl && kind === 'event' ? upcoming(tl, input.now) : null
  const matchName = next?.label ?? 'the next match'
  const clock = input.clockText ?? defaultClock
  let big = 'Next match: not known yet'
  if (kind === 'event') {
    if (next) big = `Next match: ${next.label}${next.startsAt !== null ? ` at ${clock(next.startsAt)}` : ''}${next.leftMinutes !== null ? ` · in ${next.leftMinutes} min` : ''}`
    else if (tl!.last) big = 'Next match: none left on the team\'s schedule'
  }
  const queue: NowTask = { id: 'queue', title: `Queue check for ${matchName}`, detail: 'Robot tethered, Driver Station connected, then Connect.', done: false, button: 'Start the queue check', action: go('foresight'), primary: false }
  let triage: NowTask
  if (!board) {
    const n = input.libraryToday
    const hubNone = hub && n === 0
    triage = {
      id: 'triage', title: "Open today's logs on the board",
      detail: hub ? (n ? `${plural(n, 'log')} from today in the library` : 'No logs from today in the library yet: pull one first.') : "Choose today's logs in the Session view.",
      done: false, button: hubNone ? null : hub ? 'Open the board' : 'Open the Session view', action: hubNone ? null : hub ? { kind: 'board' } : go('session'), primary: false,
    }
  } else {
    const due = redsDue(board)
    triage = {
      id: 'triage', title: `Triage before ${matchName}`,
      detail: due ? `${plural(due, 'red')} due before ${matchName}` : `No reds due before ${matchName}`,
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

/** Whether a pull's refusal means the robot did not answer (as opposed to "it is enabled", "it is on the field"). Matches the words `checkRobotIdle` (src/hub/robot.ts) uses. */
export const robotNotFound = (reason: string): boolean => /^Could not check the robot|^The robot did not say whether/.test(reason)
