/**
 * The issue board (ADR 4): one list of what is wrong with the robot at an event, across matches and pit runs, answering
 * "what must be done before our next match, and by whom?". Pure: the session (as the team's marks show it), the history,
 * the schedule and `now` come in; nothing is read from the page, the clock or the network.
 *
 * An issue is a finding's key, on the robot of the latest log it fired in (`boardKey`). What the team did about it is board
 * lines in the history (priority, status, deferral, workaround, owner, notes, queue ticks). "Closed" is never stored: it is
 * derived, after a fix (a `check` status line, or a fixed mark) from a later match of the same robot where the rule could be
 * checked and the issue did not fire. Firing again after a fix is "came back after a fix" and reopens it.
 */
import { makerOf } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import { mergeFindings, type MergedFinding, type Session } from '../session/session.ts'
import { robotIdOf, summaryRobot, type MatchSummary, type SummaryFinding } from '../session/summary.ts'
import { profileId } from '../profiles/index.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { tickAt } from './ticks.ts'
import { shortMatchLabel } from '../ui/match-label.ts'
import type { ScheduledMatch } from '../tba/schedule.ts'
import { boardKey, boardState, compareEvents, eventNotes, type BoardEvent, type BoardRole, type BoardState, type CauseState, type HistoryEvent, type Triage } from '../triage/history.ts'
import { matchRef, ruleOf, trackRecord, type Fire } from '../triage/track-record.ts'
import { beforeNext, dueByPriority, eventOver, nextEvent, durText, gapText, qualFromStored, resolveUntil, suggestions, timeline, type DuePoint, type Suggestion, type Timeline } from './points.ts'

export type Priority = 'red' | 'amber' | 'low'
export type Status = 'open' | 'fixing' | 'check' | 'deferred' | 'closed'
export type RowClass = 'due' | 'new' | 'carried' | 'later' | 'grey'

/** The red cap (ISA-18.2: every red must call for an action) and the matches without a sighting or a change after which an issue goes grey. Judgment, from the board mock; Kevin has an open decision on grey. */
export const RED_CAP = 5
export const GREY_AFTER = 3

export const PRIORITY_WORDS: Record<Priority, string> = { red: 'Red', amber: 'Amber', low: 'Low' }
/** Shape as well as colour: the word is always beside it. */
export const PRIORITY_ICON: Record<Priority, string> = { red: '●', amber: '▲', low: '○' }
export const STATUS_WORDS: Record<Status, string> = { open: 'Open', fixing: 'Fixing', check: 'Check next match', deferred: 'Deferred', closed: 'Closed' }
/** Kevin's ruling, 2026-10-24: an E-stop is often deliberate, so it defaults to amber whatever its severity (a board priority line still sets it), and its row action asks before it blames. */
export const ESTOP_RULE = 'comms/emergency-stop'
export const ESTOP_STEP = 'Ask the drive team whether the E-stop was planned (no blame); if it wasn\'t, look for the fault just before it.'
const FROM_BOARD: Record<string, Priority> = { high: 'red', medium: 'amber', low: 'low' }
export const TO_BOARD: Record<Priority, string> = { red: 'high', amber: 'medium', low: 'low' }

export interface Sighting {
  kind: 'match' | 'pit'
  /** "Q28", or "Pit run". */
  label: string
  at: number | null
  severity: Finding['severity']
  title: string
  /** Logs of the match, when it was recorded in several. */
  logs: number
}

export interface BoardIssue {
  key: string
  rule: string
  about: string | null
  robot: string
  /** The rule's title in plain words, and the latest finding's wording. */
  ruleTitle: string
  title: string
  /** Which mechanism it is about (the profile's own name for it) or, when the finding names no device in the profile, its rule family. */
  mechanism: string
  byProfile: boolean
  severity: Finding['severity']
  priority: Priority
  prioritySet: boolean
  status: Status
  /** The student's own status line, or what a fixed mark implies. */
  asked: 'open' | 'fixing' | 'check'
  owner: string | null
  cameBack: boolean
  closedAt: string | null
  deferral: { point: DuePoint; workaround: string; role: BoardRole; match: string | null; when: string; expired: boolean } | null
  due: DuePoint
  /** On the board, not closed. */
  open: boolean
  cls: RowClass
  grey: boolean
  unchanged: number
  /** Matches since it last fired (a sighting only: a board change does not reset it). */
  sinceSeen: number
  /** Status check and not seen for GREY_AFTER matches: closed by hand and waiting for a clean match where the rule can be checked. Not in the gate, not in "no owner"; still an open red. */
  awaitingClean: boolean
  /** Seen in n matches of the m where the rule could be checked. */
  seenIn: { n: number; of: number; pit: number }
  /** A grey issue shows no due point; in its place the row asks this (owner ruling 2026-10-24), with two actions (writes.ts greyClose, greyTake). */
  greyAsk: string | null
  isNew: boolean
  /** Matches (indexes into session.matches) where it fired, and pit runs. */
  firedIn: number[]
  firstSeen: number
  lastSeen: number
  sightings: Sighting[]
  /** The next step as the latest finding has it. */
  nextStep: string
  latest: SummaryFinding | null
  notes: { text: string; role: BoardRole; match: string | null; when: string }[]
  lastChange: { role: BoardRole; match: string | null; when: string } | null
  /** What the debug workspace recorded per cause id: possible (with a note), ruled out by a test, or confirmed. A cause not here is possible. */
  causeMarks: Record<string, { state: CauseState; test: string; text: string; role: BoardRole; when: string; match: string | null }>
  /** Ticks for the queue sheet. */
  checked: { match: string; role: BoardRole; when: string }[]
  merged: MergedFinding
}

export interface Strip {
  /** Reds due before the next match (the gate), not deferred, not closed, not grey. */
  gate: number
  /** Where "next" points: the match label, or null with no schedule. */
  nextLabel: string | null
  /** Match to match spacing in minutes (the gap includes the match itself), or null. */
  minutes: number | null
  /** "≈ 61 min left (est.)" when the start is near enough to count from now, else "≈ 83 min after Q33 (est.)", else null. */
  minutesWord: string | null
  deferralsDue: number
  noOwner: number
  reds: number
  /** Of those, deferred (they still count: a deferral does not make a red go away). */
  deferredReds: number
  /** Reds closed by hand and waiting for a clean match (awaitingClean). */
  awaitingReds: number
  /** With a schedule and no match left on it: the event is over, so the gate reads "open", not "due before the next match". */
  over: boolean
  /** The next named gap after the next match, in words, or null. */
  nextGap: string | null
}

export interface Board {
  tl: Timeline
  issues: BoardIssue[]
  /** Open rows in board order (class, reds first, due point). */
  rows: BoardIssue[]
  /** Above the line, and below it (after the RED_CAP-th red; never hidden). */
  visible: BoardIssue[]
  below: BoardIssue[]
  closed: BoardIssue[]
  strip: Strip
  /** What the TBA key unlocks, when there is no schedule. */
  noSchedule: string | null
  labels: string[]
  /** The line for each match: what we changed in the pit, latest per match. */
  pitLines: { match: string; text: string; role: BoardRole }[]
  /** The last handoff read, if any. */
  handoff: { role: BoardRole; match: string; when: string } | null
  /** Where the next match is, by the label ticks are filed under ("Q41", or "after Q33" with no schedule). */
  tickFor: string
  /** The same, for people: "Q41", or "the next match" with no schedule. */
  tickLabel: string
  /** The latest match has no time and no event name: a tick written now can't be tied to this event. */
  untied: boolean
  missed: { text: string; role: BoardRole; match: string; when: string }[]
}

export interface BoardInput {
  /** The event session as the team's marks show it (`sessionWithMarks`). */
  session: Session
  history: HistoryEvent[]
  /** `triage(history)`. */
  marks: Triage
  /** The team's schedule at the event; null when none was read. */
  schedule: readonly ScheduledMatch[] | null
  profiles: readonly RobotProfile[]
  /** The moment the board is read: the time left to the next match counts from it. */
  now?: Date
}

const ms = (iso: string | undefined): number | null => { const t = iso ? Date.parse(iso) : NaN; return Number.isNaN(t) ? null : t }

/** The robot as a board line names it: the profile id, or `summaryRobot()`'s name for a guess that does not fit. */
export function robotOf(m: MatchSummary): string { return robotIdOf(m.robot) }

/** "Q28" from a stored match ("<event> Qualification 28", "Q28") given its event name. */
export function shortStored(match: string | undefined, event?: string): string | null {
  if (!match) return null
  const label = event && match.startsWith(`${event} `) ? match.slice(event.length + 1) : match
  if (/^[A-Za-z]{1,6}\d+$/.test(label)) return label
  // "<event> Qualification 28": the match type and number are the end of it (an event name can hold digits and spaces).
  const typed = /(qualification|practice|playoff|quarterfinal|semifinal|final|elimination)\s*\d+$/i.exec(label)
  return typed ? shortMatchLabel(typed[0], 0) : /\d$/.test(label) ? shortMatchLabel(label, 0) : label
}

/** The rule families a finding falls under when it names no device in the robot's profile. */
export function familyOf(rule: string): string {
  const area = rule.split('/')[0]
  if (area === 'power') return 'Power'
  if (area === 'can') return 'CAN'
  if (area === 'comms') return 'Comms'
  if (area === 'code' || area === 'build' || area === 'loop') return 'Code'
  return 'Other'
}
export const FAMILIES = ['Power', 'CAN', 'Comms', 'Code', 'Other']

/** The profile's name for the mechanism a finding is about (a motor group or a motor in it, a camera, a device, a zeroed mechanism), else the rule family. */
export function mechanismOf(rule: string, about: string | null, profile: RobotProfile | undefined): { name: string; byProfile: boolean } {
  if (profile && about) {
    const g = profile.motorGroups.find((x) => x.name === about || x.motors.some((m) => m.name === about))
    if (g) return { name: g.name, byProfile: true }
    const named = profile.cameras.find((c) => c.name === about)?.name
      ?? profile.otherDevices.find((d) => d.name === about)?.name
      ?? profile.zeroing.find((z) => z.mechanism === about)?.mechanism
    if (named) return { name: named, byProfile: true }
  }
  return { name: familyOf(rule), byProfile: false }
}

/** Every name a session's notes may be filed under: its TBA key, the event name the field data gave, its label. A note written before the key was found has the name. */
export function eventIdsOf(session: Pick<Session, 'event' | 'matches' | 'label'>): string[] {
  const named = session.matches.find((m) => m.onField && m.event)?.event
  return [...new Set([session.event?.key, named, session.label].filter((x): x is string => !!x))]
}
/** The one a new note is filed under: the TBA key when there is one, else the event name, else the label. */
export const eventIdOf = (session: Pick<Session, 'event' | 'matches' | 'label'>): string => eventIdsOf(session)[0]

/** A short label as the board writes one ("Q41"). A longer reference carries its event ("<event> Qualification 41") and must match that event's own match, never another event's. */
const SHORT = /^[A-Za-z]{1,6}\d+$/

/** The index of the session match a stored reference names (a match id, a short label), else the one a time falls after (-1: before them all). */
function indexOfMatch(session: Session, labels: string[], ref: string | undefined | null, when?: string): number {
  if (ref) {
    const i = session.matches.findIndex((m, j) => matchRef(m, m.playedAt).id === ref || (SHORT.test(ref) && labels[j] === ref))
    if (i >= 0) return i
  }
  const t = ms(when)
  if (t === null) return -1
  let idx = -1
  session.matches.forEach((m, i) => { if (m.playedAt !== null && m.playedAt <= t) idx = i })
  return idx
}

const finds = (m: MatchSummary, rule: string, key: string): SummaryFinding | undefined => m.rules[rule]?.findings.find((f) => f.key === key && f.severity !== 'info')

/** The moment a fix line counts from: the played time of the match it was made on, else when it was written (same clock as the logs). */
const fixTime = (e: { played?: string; when: string }): number | null => ms(e.played) ?? ms(e.when)

export interface Scope { event: string; from: number | null; to: number | null }
/** The event a tick or a deferral must belong to (ADR 4: it is about this event's matches): the FMS event name, and the span of the session's matches. */
export function scopeOf(session: Session): Scope {
  const t = session.matches.map((m) => m.playedAt).filter((x): x is number => x !== null)
  return { event: session.matches.find((m) => m.onField && m.event)?.event ?? '', from: t.length ? Math.min(...t) : null, to: t.length ? Math.max(...t) : null }
}
/** FMS event names repeat every year, so a name match with a played time must also fall within this long of the session's span. */
const SAME_NAME_WITHIN = 30 * 86400e3

/** A next-event deferral is worth showing as ended only when it says where it was made (an event name or a played time) and that was within this long before the session began. */
const ENDED_SHOWN_WITHIN = 120 * 86400e3
function madeJustBefore(line: { event?: string; played?: string; when: string }, sc: Scope): boolean {
  if (!line.event && !line.played) return false
  const t = ms(line.played) ?? ms(line.when)
  return t !== null && sc.from !== null && t >= sc.from - ENDED_SHOWN_WITHIN && t <= sc.from
}

/** "Seen in 2 of 9 matches and 1 pit run"; a pit-run-only issue reads "Seen in 2 pit runs (no match)". */
export function seenText(s: { n: number; of: number; pit: number }): string {
  const pit = (n: number) => `${n} pit run${n === 1 ? '' : 's'}`
  if (s.n === 0 && s.pit > 0) return `Seen in ${pit(s.pit)} (no match)`
  return `Seen in ${s.n} of ${s.of} match${s.of === 1 ? '' : 'es'}${s.pit ? ` and ${pit(s.pit)}` : ''}`
}

/** A line counts here when its event equals the session's FMS event name (both named; if it has a played time, that must be within 30 days of the session's span), else when its played time falls inside the session's span. A line that says neither does not count. */
export function inScope(line: { event?: string; played?: string }, sc: Scope): boolean {
  if (line.event && sc.event) {
    if (line.event !== sc.event) return false
    const t = ms(line.played)
    return t === null || sc.from === null || sc.to === null || (t >= sc.from - SAME_NAME_WITHIN && t <= sc.to + SAME_NAME_WITHIN)
  }
  const t = ms(line.played)
  return t !== null && sc.from !== null && sc.to !== null && t >= sc.from && t <= sc.to
}

function lastStatusLines(history: HistoryEvent[]): Map<string, { value: string; t: number | null; when: string }> {
  const out = new Map<string, { value: string; t: number | null; when: string }>()
  const lines = history.filter((e): e is BoardEvent => e.type === 'board' && e.op === 'status')
  lines.sort(compareEvents)
  for (const e of lines) out.set(boardKey(e.key, e.robot), { value: e.value, t: fixTime(e), when: e.when })
  return out
}

export function buildBoard(input: BoardInput): Board {
  const { session, history, marks, schedule, profiles } = input
  const labels = session.matches.map((m, i) => shortMatchLabel(m.matchLabel, i))
  const tl = timeline(session, schedule, (m) => labels[session.matches.indexOf(m)] ?? shortMatchLabel(m.matchLabel, 0), input.now?.getTime())
  const scope = scopeOf(session)
  const states = boardState(history)
  const statusLines = lastStatusLines(history)
  // Only this event's notes (under any of its names, read as one): the latest pit-change per match, and a handoff read counts for its own event.
  const ids = eventIdsOf(session)
  const mine = history.flatMap((e): HistoryEvent[] => (e.type === 'event-note' && ids.includes(e.event) ? [{ ...e, event: ids[0] }] : []))
  const all = eventNotes(mine)
  const notes = { pitChange: [...all.pitChange.values()], missed: all.missed, handoffReads: all.handoffReads }
  const pit = session.pitRuns ?? []
  const lastIdx = session.matches.length - 1

  // Sightings: matches, then pit runs (a pit-run sighting is never a match).
  const pitIndex = (p: MatchSummary) => (p.playedAt === null ? lastIdx : session.matches.reduce((n, m, i) => (m.playedAt !== null && m.playedAt <= p.playedAt! ? i : n), -1))
  const mergedMatches = new Map(mergeFindings(session).map((f) => [f.key, f]))
  const mergedPit = new Map(mergeFindings({ ...session, matches: pit }).map((f) => [f.key, f]))
  const keys = [...new Set([...mergedMatches.keys(), ...mergedPit.keys()])]
  const order = new Map([...mergedMatches.keys(), ...mergedPit.keys()].map((k, i) => [k, i]))

  const issues: BoardIssue[] = []
  for (const key of keys) {
    const merged = mergedMatches.get(key) ?? { ...mergedPit.get(key)!, matches: [] as number[] }
    // Marked "not a real problem" in every match it fired in (and no pit sighting): filed, not on the board.
    if ((merged.wrong?.length ?? 0) > 0 && merged.wrong!.length === merged.matches.length && !mergedPit.has(key)) continue
    const rule = merged.rule
    const about = key.includes(' · ') ? key.slice(key.indexOf(' · ') + 3) : null
    const firedIn = merged.matches
    const matchFires = session.matches.map((m, i) => ({ m, i, f: finds(m, rule, key) })).filter((x) => x.f)
    const pitFires = pit.map((p) => ({ p, f: finds(p, rule, key) })).filter((x) => x.f)
    const latestFire = matchFires.at(-1)
    const latestPit = pitFires.at(-1)
    const robot = latestFire ? robotOf(latestFire.m) : latestPit ? robotOf(latestPit.p) : ''
    const state: BoardState | undefined = states.get(boardKey(key, robot))
    const sightings: Sighting[] = [
      ...matchFires.map(({ m, i, f }): Sighting => ({ kind: 'match', label: labels[i], at: m.playedAt, severity: f!.severity, title: f!.title, logs: m.pieces?.length ?? 1 })),
      ...pitFires.map(({ p, f }): Sighting => ({ kind: 'pit', label: 'Pit run', at: p.playedAt, severity: f!.severity, title: f!.title, logs: 1 })),
    ]
    const latest = latestFire?.f ?? latestPit?.f ?? null

    // Priority: the latest board line, else the severity (an error is red, a warning amber).
    const prioritySet = !!state?.priority && state.priority in FROM_BOARD
    const priority: Priority = prioritySet ? FROM_BOARD[state!.priority!] : merged.severity === 'error' && rule !== ESTOP_RULE ? 'red' : 'amber'

    // The fix: a `check` status line (still the latest status) or a fixed mark, whichever is later.
    const st = statusLines.get(boardKey(key, robot))
    const mark = marks.issues.get(key)
    const markT = mark?.status === 'fixed' ? fixTime(mark) : null
    const checkT = st?.value === 'check' ? st.t : null
    const reopened = !!st && st.value !== 'check' && markT !== null && ((st.t ?? 0) > markT || ((st.t ?? 0) === markT && st.when > mark!.when))
    const fixT = reopened ? checkT : [checkT, markT].filter((t): t is number => t !== null).reduce<number | null>((a, t) => (a === null || t > a ? t : a), null)
    let cameBack = false
    let closedAt: string | null = null
    if (fixT !== null) {
      // After the fix, in time order: a fire (in a match of this robot or a pit run) reopens it; a clean match where the rule could be checked closes it.
      const later = [
        ...session.matches.map((m, i) => ({ m, i, pit: false })),
        ...pit.map((m) => ({ m, i: -1, pit: true })),
      ].filter((x) => x.m.playedAt !== null && x.m.playedAt > fixT && robotOf(x.m) === robot).sort((a, b) => a.m.playedAt! - b.m.playedAt!)
      for (const x of later) {
        const f = finds(x.m, rule, key)
        if (f && !f.wrongMark) { cameBack = true; closedAt = null; break }
        if (!x.pit && !f && (x.m.rules[rule]?.status ?? 'not checked') !== 'not checked' && closedAt === null) closedAt = labels[x.i]
      }
    }
    const closed = closedAt !== null && !cameBack
    // A status line older than the fixed mark that closed over it no longer says anything.
    const markWins = !!st && st.value !== 'check' && markT !== null && !reopened
    const lineStatus = !markWins && (state?.status === 'fixing' || state?.status === 'check' || state?.status === 'open') ? state.status : undefined
    const asked: BoardIssue['asked'] = cameBack ? (lineStatus === 'fixing' ? 'fixing' : 'open') : fixT !== null ? (lineStatus === 'fixing' ? 'fixing' : 'check') : (lineStatus ?? 'open')

    // The deferral: live while its point is not behind the next match.
    let deferral: BoardIssue['deferral'] = null
    if (state?.deferred && !inScope(state.deferred, scope) && state.deferred.until?.kind === 'next-event' && madeJustBefore(state.deferred, scope)) {
      // "Until the next event", read at an event after the one it was made at: over. Shown as ended, with its workaround, not dropped,
      // when it names its event or played time and was made within 120 days before this session; any other is dropped.
      deferral = { point: nextEvent(), workaround: state.workaround ?? '', role: state.deferred.by.role, match: shortStored(state.deferred.match), when: state.deferred.when, expired: true }
    } else if (state?.deferred && inScope(state.deferred, scope)) {
      const point = state.deferred.until ? resolveUntil(state.deferred.until, tl) : beforeNext(tl)
      const madeAt = indexOfMatch(session, labels, state.deferred.match, state.deferred.when)
      // A next-match deferral that names no match is "the next one when it was made": once a match is played after it, it is over,
      // schedule or not. With a schedule a point is over when it is behind the next match; with none, when the latest qualification has reached the match it names.
      const u = state.deferred.until
      const unnamed = !u || (u.kind === 'next-match' && qualFromStored(u.match) === null)
      const named = qualFromStored(point.match ?? undefined)
      const lastQual = tl.last?.qual ?? null
      const expired = (unnamed && madeAt < lastIdx) || (tl.hasSchedule ? point.pos < tl.nextPos : named !== null && lastQual !== null && (u?.kind === 'gap' ? lastQual > named : lastQual >= named))
      deferral = { point, workaround: state.workaround ?? '', role: state.deferred.by.role, match: shortStored(state.deferred.match), when: state.deferred.when, expired }
    }
    const live = !!deferral && !deferral.expired
    const status: Status = closed ? 'closed' : live ? 'deferred' : asked
    const due = live ? deferral!.point : dueByPriority(priority, tl)
    // The denominator is the merged finding's own count of matches the rule could be checked in (0 for a pit-run-only issue).
    const checkable = mergedMatches.get(key)?.checkable ?? 0

    // Activity, for "grey": the last sighting or board change, counted in the team's matches.
    const changeIdx = state?.changed ? indexOfMatch(session, labels, state.match, state.when) : -1
    const pitIdx = pitFires.map(({ p }) => pitIndex(p))
    const seen = [...firedIn, ...pitIdx]
    const lastSeen = seen.length ? Math.max(...seen) : -1
    const firstSeen = seen.length ? Math.min(...seen) : -1
    const unchanged = lastIdx - Math.max(lastSeen, changeIdx)
    const sinceSeen = lastIdx - lastSeen
    const awaitingClean = status === 'check' && sinceSeen >= GREY_AFTER
    const grey = unchanged >= GREY_AFTER && !live && !closed && !awaitingClean

    // "New": first seen after the last handoff was read (none read: nothing is new to compare with).
    const read = notes.handoffReads.at(-1)
    const readIdx = read ? indexOfMatch(session, labels, read.match, read.when) : null
    const isNew = readIdx !== null && firstSeen > readIdx

    const profile = profiles.find((p) => profileId(p) === robot)
    const mech = mechanismOf(rule, about, profile)
    const maker = makerOf(rule)
    const cls: RowClass = live ? (due.pos <= tl.nextPos ? 'due' : 'later') : grey ? 'grey' : isNew ? 'new' : 'carried'
    const issue: BoardIssue = {
      key, rule, about, robot, ruleTitle: maker?.title ?? rule, title: latest?.title ?? merged.title, mechanism: mech.name, byProfile: mech.byProfile,
      severity: merged.severity, priority, prioritySet, status, asked, owner: state?.owner ?? null, cameBack, closedAt, deferral, due,
      open: !closed, cls, grey, unchanged, sinceSeen, awaitingClean, seenIn: { n: firedIn.length, of: Math.max(checkable, firedIn.length), pit: pitFires.length }, greyAsk: grey ? `Not seen for ${unchanged} matches: close it, or give it an owner?` : null, isNew, firedIn, firstSeen, lastSeen, sightings,
      nextStep: rule === ESTOP_RULE ? ESTOP_STEP : latest?.nextStep ?? maker?.nextStep ?? '', latest,
      notes: (state?.notes ?? []).map((n) => ({ text: n.text, role: n.by.role, match: shortStored(n.match), when: n.when })),
      lastChange: state?.changed ? { role: state.by.role, match: shortStored(state.match), when: state.when } : null,
      causeMarks: Object.fromEntries(Object.entries(state?.causes ?? {}).map(([id, c]) => [id, { state: c.state, test: c.test, text: c.text, role: c.by.role, when: c.when, match: shortStored(c.match) }])),
      checked: (state?.checked ?? []).filter((c) => inScope(c, scope)).map((c) => ({ match: c.match, role: c.by.role, when: c.when })),
      merged,
    }
    issues.push(issue)
  }
  issues.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))

  const isRed = (i: BoardIssue) => i.priority === 'red' && !i.grey
  const classRank: Record<RowClass, number> = { due: 0, new: 1, carried: 2, later: 3, grey: 4 }
  const open = issues.filter((i) => i.open)
  // Inside a class: reds first, then by due point; ties keep the findings' own order (worst first).
  const rows = [...open].sort((a, b) => classRank[a.cls] - classRank[b.cls] || Number(isRed(b)) - Number(isRed(a)) || a.due.pos - b.due.pos)
  const visible: BoardIssue[] = []
  const below: BoardIssue[] = []
  let reds = 0
  let cut = false
  for (const i of rows) {
    if (!cut && isRed(i)) { if (reds >= RED_CAP) cut = true; else reds++ }
    ;(cut ? below : visible).push(i)
  }

  const gate = rows.filter((i) => isGate(i, tl))
  const nextGap = tl.named[0] ? `${gapText(tl.named[0])}${tl.named[0].minutes !== null ? ` (≈ ${durText(tl.named[0].minutes)}, est.)` : ''}` : null
  const strip: Strip = {
    gate: gate.length, nextLabel: tl.next?.label ?? null, minutes: tl.next?.minutes ?? null,
    minutesWord: tl.next?.leftMinutes != null ? `≈ ${durText(tl.next.leftMinutes)} left (est.)` : tl.next?.minutes != null && tl.last ? `≈ ${durText(tl.next.minutes)} after ${tl.last.label} (est.)` : null,
    deferralsDue: rows.filter((i) => i.cls === 'due').length, noOwner: rows.filter((i) => !i.grey && !i.awaitingClean && !i.owner).length,
    reds: rows.filter(isRed).length, deferredReds: rows.filter((i) => isRed(i) && i.status === 'deferred').length, awaitingReds: rows.filter((i) => isRed(i) && i.awaitingClean).length, nextGap, over: eventOver(tl),
  }
  const tickFor = tl.next?.label ?? `after ${tl.last?.label ?? 'now'}`
  const read = notes.handoffReads.at(-1)
  return {
    tl, issues, rows, visible, below, closed: issues.filter((i) => !i.open), strip,
    noSchedule: tl.hasSchedule ? null : 'No schedule: due points say "the next match" and "the end of the event". A team number and a Blue Alliance read key add match numbers and gaps.',
    labels,
    pitLines: notes.pitChange.map((n) => ({ match: n.match, text: n.text, role: n.by.role, at: indexOfMatch(session, labels, n.match, n.when) })).sort((a, b) => a.at - b.at).map(({ match, text, role }) => ({ match, text, role })),
    handoff: read ? { role: read.by.role, match: read.match, when: read.when } : null,
    tickFor, tickLabel: tl.next?.label ?? 'the next match',
    untied: (() => { const m = session.matches.filter((x) => x.onField).at(-1); return !!m && m.playedAt === null && !m.event })(),
    missed: notes.missed.map((n) => ({ text: n.text, role: n.by.role, match: n.match, when: n.when })),
  }
}

/** A red due before the next match that is neither deferred, closed nor grey: what the queue sheet gates on. */
export function isGate(i: BoardIssue, tl: Timeline): boolean {
  // A grey red that was closed (status check) and has still not been seen for 3 matches is waiting for its clean match, not due: Close must not put it back in the gate.
  if (i.awaitingClean) return false
  return i.open && i.priority === 'red' && !i.grey && i.status !== 'deferred' && i.due.pos <= tl.nextPos
}

/** A tick for the match counts while it is fresh: 90 minutes, as Foresight's ticks (`tickAt`). With no clock (`now` null) it is not aged. */
export function isChecked(i: BoardIssue, tickFor: string, now: number | null = null): boolean {
  const c = i.checked.filter((x) => x.match === tickFor).at(-1)
  return !!c && (now === null || !tickAt(c.role, c.when, now).old)
}

/** The deferral points to offer for an issue (ADR 6), with Hindsight's pick marked. */
export function deferralOptions(board: Pick<Board, 'tl'>): Suggestion[] {
  return suggestions(board.tl)
}

// ---- the "not a real problem" rates, one row per rule that fired at the event ----

export interface RuleRate {
  rule: string
  title: string
  fired: number
  real: number
  wrong: number
  /** "2 of 9 marked not a real problem", or "no marks yet (fired 9 times)". */
  text: string
}

/** Every rule that fired at the event (matches and pit runs), with the team's "not a real problem" counts from track-record.ts. */
export function ruleRates(session: Session, marks: Triage, history: HistoryEvent[]): RuleRate[] {
  const fires: Fire[] = []
  for (const m of [...session.matches, ...(session.pitRuns ?? [])]) {
    const { id, played } = matchRef(m, m.playedAt)
    for (const r of Object.values(m.rules)) for (const f of r.findings) if (f.severity !== 'info') fires.push({ key: f.key, match: id, played })
  }
  const rules = [...new Set(fires.map((f) => ruleOf(f.key)))]
  return rules.map((rule) => {
    const r = trackRecord(rule, marks, history, fires)
    const text = r.wrong === 0 && r.real === 0 ? `no marks yet (fired ${r.fired} time${r.fired === 1 ? '' : 's'})` : `${r.wrong} of ${r.fired} marked not a real problem${r.real ? `; ${r.real} marked real` : ''}`
    return { rule, title: makerOf(rule)?.title ?? rule, fired: r.fired, real: r.real, wrong: r.wrong, text }
  }).sort((a, b) => b.fired - a.fired || a.rule.localeCompare(b.rule))
}

