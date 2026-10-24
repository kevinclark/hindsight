/**
 * Foresight's two checklists (ADR 9), both read off the one engine (verdict.ts / onchecks.ts): nothing here judges a
 * signal, it only groups what the engine found.
 *
 * The queue checklist (event mode, do-confirm): the robot's systems, most critical first, each Go, Go with deferral or
 * No-go. A live red the board has deferred reads Go with deferral and names its workaround, never hidden (ADR 4: every
 * issue can be deferred); every other open deferral for the robot is listed too, seen live or not (the pre-match check
 * reads all open deferrals together). The overall word is NO-GO if any system is No-go, NOT CHECKED as before, GO WITH
 * n DEFERRAL(S) while any is open (never green, never plain GO), else GO.
 *
 * The practice-start checklist (practice mode, read-do): the lines of the team's pit checklist in a fixed order, each
 * done or left, ending "Ready to drive" or "n left: …". It has no Go verdict at all.
 */
import type { Verdict, VerdictItem } from './verdict.ts'
import type { MarkedLine } from './onchecks.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { profileId } from '../profiles/index.ts'
import { buildBoard, inScope, mechanismOf, robotOf, scopeOf, type Board, type BoardIssue } from '../board/model.ts'
import { NEXT_EVENT } from '../board/points.ts'
import { FORESIGHT_RULES, makerOf } from '../rules/index.ts'
import { ONCHECKS } from './onchecks.ts'
import { SNAPSHOT_RULES } from './snapshot-checks.ts'
import { goWithWord, rowTitle } from '../board/words.ts'
import { sessionWithMarks } from '../triage/track-record.ts'
import { boardKey, boardState, triage, type HistoryEvent } from '../triage/history.ts'
import type { Session } from '../session/session.ts'

// ---- systems ----

export const SYSTEMS = ['Power', 'CAN', 'Comms', 'Drivetrain', 'Vision', 'Mechanisms', 'Code'] as const
export type System = (typeof SYSTEMS)[number]

/** A motor group that is the drivetrain: judgment (the team's profiles name it Drive; another team's may say Swerve or Modules). */
const DRIVE_GROUP = /drive|swerve|steer|module/i

/** Rules whose finding names no device in the profile: which system each belongs to. A rule not listed is a mechanism's. */
const RULE_SYSTEM: Record<string, System> = {
  'foresight/controllers': 'Comms', 'alerts/passthrough': 'Code',
  'foresight/sticky-faults': 'CAN', 'foresight/firmware-mismatch': 'CAN', 'foresight/values-updating': 'CAN',
  'foresight/camera-sees-tag': 'Vision', 'foresight/zero-sanity': 'Mechanisms', 'foresight/motor-temperature': 'Mechanisms',
  'foresight/log-usb-stick': 'Code', 'foresight/commit-matches': 'Code', 'foresight/gyro-still-drift': 'Drivetrain',
  'snapshot/devices': 'CAN', 'snapshot/licensed': 'CAN', 'snapshot/cancoder-offsets': 'Drivetrain', 'snapshot/swerve-ratio': 'Drivetrain',
  'snapshot/current-limits': 'Mechanisms', 'snapshot/code-settings': 'Code',
}
const AREA_SYSTEM: Record<string, System> = { battery: 'Power', vision: 'Vision', collision: 'Drivetrain', code: 'Code', build: 'Code' }

/**
 * The system a finding goes to, by the board's own grouping ("By mechanism", model.ts mechanismOf): the profile's name for
 * what it is about (a camera is Vision, a drive group is Drivetrain, another motor group a Mechanism, another device CAN),
 * else its rule family (Power, CAN, Comms, Code); a rule in none of those goes by RULE_SYSTEM, else to Mechanisms.
 */
export function systemOf(rule: string, about: string | null, profile: RobotProfile | undefined): System {
  const m = mechanismOf(rule, about, profile)
  if (m.byProfile && profile) {
    if (profile.cameras.some((c) => c.name === m.name)) return 'Vision'
    if (profile.otherDevices.some((d) => d.name === m.name)) return 'CAN'
    if (profile.motorGroups.some((g) => g.name === m.name)) return DRIVE_GROUP.test(m.name) ? 'Drivetrain' : 'Mechanisms'
    return 'Mechanisms'
  }
  if ((SYSTEMS as readonly string[]).includes(m.name)) return m.name as System
  return RULE_SYSTEM[rule] ?? AREA_SYSTEM[rule.split('/')[0]] ?? 'Mechanisms'
}

// ---- open deferrals ----

export interface OpenDeferral {
  /** The issue key (the finding key). */
  key: string
  system: System
  /** "Drivetrain · Motors on one loop at different speeds (Front left)": the board's own title. */
  title: string
  workaround: string
  /** "the end of the event", "Q41": the board's `deferral.point.until`. */
  until: string
  /** Set when the board is an earlier event's: the event it was made at. Only a deferral to the next event carries over. */
  carriedFrom?: string
}

/** The event a session is, in words: The Blue Alliance's name, the field's, else its label. */
export const sessionEventName = (s: Pick<Session, 'event' | 'matches' | 'label'>): string => s.event?.name ?? s.matches.find((m) => m.onField && m.event)?.event ?? s.label

/** The repo's same-event window: logs of one event lie within this long of each other (src/session/session.ts groups by it). */
const SAME_EVENT_MS = 4 * 86400e3

/**
 * Whether the deferral session is an earlier event than today's, so only what was deferred to the next event carries over.
 * It is today's event when it is the session the mode line found, or The Blue Alliance's signal names its event (the same
 * key, or the same name), or its last log is within the same-event window (day two of an event, with no log of today loaded).
 */
export function isCarried(session: Session, todaySessionId: string, external: { key?: string; name: string } | null, now: number): boolean {
  if (session.id === todaySessionId) return false
  if (external?.key && session.event?.key) return session.event.key !== external.key // two named events: the keys decide, whatever the dates
  // A session the field named (every competition log) has no TBA key of its own: TBA's key without its year is the field's name (session.ts).
  const fms = session.matches.find((m) => m.onField && m.event)?.event?.toLowerCase()
  if (external?.key && fms) return external.key.slice(4).toLowerCase() !== fms
  const norm = (x: string) => x.trim().toLowerCase()
  if (external && norm(sessionEventName(session)) === norm(external.name)) return false
  const last = Math.max(0, ...[...session.matches, ...(session.pitRuns ?? [])].map((m) => m.playedAt ?? 0))
  return now - last > SAME_EVENT_MS
}

/** The session whose board holds the deferrals: today's event session when there is one, else the latest event session for this robot. */
export function deferralSession(sessions: readonly Session[], todaySessionId: string, robot: string): Session | null {
  const today = sessions.find((s) => s.id === todaySessionId && s.kind === 'event')
  if (today) return today
  const last = (s: Session) => Math.max(0, ...[...s.matches, ...(s.pitRuns ?? [])].map((m) => m.playedAt ?? 0))
  return sessions
    .filter((s) => s.kind === 'event' && [...s.matches, ...(s.pitRuns ?? [])].some((m) => robotOf(m) === robot))
    .sort((a, b) => last(b) - last(a))[0] ?? null
}

/** The board for a session, as the Session view builds it (marks applied). Foresight has no Blue Alliance schedule: the board is read without one. */
export function boardFor(session: Session, history: HistoryEvent[], profile: RobotProfile, now: Date): Board {
  const marks = triage(history)
  return buildBoard({ session: sessionWithMarks(session, marks), history, marks, schedule: null, profiles: [profile], now })
}

/**
 * Every open (not closed, not ended) deferral for the robot. `carriedFrom`: the board is not today's event (an earlier
 * one), so only a deferral to the next event is still open here, and it says where it came from; the earlier event's
 * "until the end of the event" and match deferrals are over.
 */
export function openDeferrals(board: Board, profile: RobotProfile, carriedFrom?: string): OpenDeferral[] {
  const robot = profileId(profile)
  return board.issues
    .filter((i): i is BoardIssue & { deferral: NonNullable<BoardIssue['deferral']> } => i.robot === robot && i.status === 'deferred' && !!i.deferral && !i.deferral.expired && (carriedFrom === undefined || i.deferral.point.pos === NEXT_EVENT))
    .map((i) => ({ key: i.key, system: systemOf(i.rule, i.about, profile), title: rowTitle(i), workaround: i.deferral.workaround, until: i.deferral.point.until, ...(carriedFrom !== undefined ? { carriedFrom } : {}) }))
}

// ---- the queue checklist ----

export type SystemWord = 'Go' | 'Go with deferral' | 'No-go' | 'Not checked' | 'Check by hand'

/**
 * What a person does for a system when none of its checks ran (never Go, never silence). The team does this every match for
 * the drivetrain (Kevin, 2026-10-24: robot on blocks, confirm the wheels spin as expected); the checklist has no other such
 * step, so any other system just reads "Check by hand".
 */
export const HAND_STEPS: Partial<Record<System, string>> = { Drivetrain: 'On blocks: enable and confirm every wheel spins the way it should' }

export interface QueueRow {
  system: System
  word: SystemWord
  /** Reds with no deferral: what makes the system No-go. */
  fix: VerdictItem[]
  /** Ambers: to look at; they never move the word. */
  look: VerdictItem[]
  /** Open deferrals of this system, seen live or not. */
  deferrals: (OpenDeferral & { seenNow: boolean })[]
  /** How many of this system's checks ran in this check, of those it has. */
  ran: { n: number; of: number }
  /** "tag not seen yet" on Vision until the camera step clears. */
  note: string | null
  /** For a row that reads Check by hand: the step. */
  step: string | null
  /** The row, in words: "Go", "Go with deferral: <issue> · workaround: <line>", "No-go: <title>". */
  text: string
}

export type QueueKind = 'GO' | 'GO WITH DEFERRALS' | 'NO-GO' | 'NOT CHECKED'

export interface QueueChecklist {
  /** The overall word, as shown: "NO-GO", "NOT CHECKED", "GO WITH 2 DEFERRALS", "GO". */
  word: string
  /** The same for the pit-check record. */
  kind: QueueKind
  reason: string
  /** At most 7 (one per system), the most critical first. */
  rows: QueueRow[]
  /** Every open deferral for the robot. */
  deferrals: OpenDeferral[]
  /** Why no deferral was read, when none could be; null otherwise. */
  deferralNote: string | null
}

/** Every check Foresight runs, to count how many of a system's ran. */
const ALL_RULES: string[] = [...FORESIGHT_RULES.map((r) => r.id), ...(SNAPSHOT_RULES as unknown as string[])]

const WORD_RANK: Record<SystemWord, number> = { 'No-go': 0, 'Not checked': 1, 'Check by hand': 1, 'Go with deferral': 2, Go: 3 }

/**
 * `verdict`: the engine's, or null with no current check. `deferrals`: null when none could be read (no event session),
 * with `deferralNote` saying why. `profile`: the robot's, for the grouping.
 */
export function queueChecklist(input: { verdict: Verdict | null; why: string; profile: RobotProfile | undefined; deferrals: OpenDeferral[] | null; deferralNote: string | null; ticks?: ReadonlyMap<System, Tick> }): QueueChecklist {
  const { verdict, profile } = input
  const open = input.deferrals ?? []
  const items = (verdict?.items ?? []).filter((i) => i.level !== 'grey')
  const systemOfItem = (i: VerdictItem) => systemOf(i.finding.rule, i.finding.about, profile)
  // A proven check that could not run leaves its system unjudged, never Go.
  const blind = verdict?.blind ?? []
  const rows: QueueRow[] = SYSTEMS.map((system) => {
    const mine = items.filter((i) => systemOfItem(i) === system)
    const reds = mine.filter((i) => i.level === 'red')
    const deferred = (i: VerdictItem) => open.some((d) => d.key === i.finding.key)
    const fix = reds.filter((i) => !deferred(i))
    const seen = new Set(reds.filter(deferred).map((i) => i.finding.key))
    const deferrals = open.filter((d) => d.system === system).map((d) => ({ ...d, seenNow: seen.has(d.key) }))
    const unjudged = !verdict || blind.some((s) => systemOf(s.rule, null, profile) === system)
    const mine_rules = ALL_RULES.filter((r) => systemOf(r, null, profile) === system)
    // One meaning of "ran", the box's own ("n of 26 checks not fully run"): a check that ran only in part did not.
    const notRan = verdict ? new Set([...verdict.notChecked, ...verdict.crashed].map((x) => x.rule)) : null
    const ran = { n: notRan ? mine_rules.filter((r) => !notRan.has(r)).length : 0, of: mine_rules.length }
    // A system whose checks all failed to run is never Go: a person checks it, and a fresh tick says they did.
    // A system with a step of the team's own (HAND_STEPS: the drivetrain, on blocks, every match) always needs the tick, however many
    // of its checks ran; any other waits for one only when none ran. In queue mode the first pit-check record therefore waits for that tick.
    const hand = !!verdict && !unjudged && ((ran.n === 0 && ran.of > 0) || system in HAND_STEPS)
    const ticked = input.ticks?.get(system)
    const handDone = hand && !!ticked && !ticked.old
    const step = hand ? HAND_STEPS[system] ?? null : null
    const word: SystemWord = fix.length ? 'No-go' : unjudged ? 'Not checked' : hand && !handDone ? 'Check by hand' : deferrals.length ? 'Go with deferral' : 'Go'
    const text = word === 'No-go' ? `No-go: ${fix.map((i) => i.finding.title).join('; ')}`
      : word === 'Go with deferral' ? `Go with deferral: ${deferrals.map((d) => `${d.title} · workaround: ${d.workaround || 'none written'}`).join('; ')}`
      : word === 'Check by hand' ? `Check by hand: ${step ?? 'none of its checks ran; a person checks it'}`
      : word === 'Not checked' ? (verdict ? 'Not checked: a check for this system could not read its signals' : 'Not checked') : 'Go'
    const tagStep = system === 'Vision' && !!verdict && verdict.items.some((i) => i.level === 'grey' && i.finding.rule === 'foresight/camera-sees-tag')
    return { system, word, fix, look: mine.filter((i) => i.level === 'amber'), deferrals, ran, note: tagStep ? 'tag not seen yet' : null, step, text }
  }).sort((a, b) => WORD_RANK[a.word] - WORD_RANK[b.word] || SYSTEMS.indexOf(a.system) - SYSTEMS.indexOf(b.system))
  const nogo = rows.filter((r) => r.word === 'No-go')
  let word: string
  let kind: QueueKind
  let reason: string
  if (nogo.length) { kind = 'NO-GO'; word = 'NO-GO'; reason = `${nogo.length} ${nogo.length === 1 ? 'system' : 'systems'} to fix before the robot goes on the field: ${nogo.map((r) => r.system).join(', ')}` }
  // A system left unjudged keeps the word NOT CHECKED whatever the engine says, and a deferral never lifts it.
  else if (!verdict || verdict.verdict === 'NOT CHECKED' || rows.some((r) => r.word === 'Not checked' || r.word === 'Check by hand')) { kind = 'NOT CHECKED'; word = 'NOT CHECKED'; reason = !verdict ? input.why : [
      ...(verdict.verdict === 'NOT CHECKED' ? [verdict.reason] : rows.some((r) => r.word === 'Not checked') ? [`could not check ${rows.filter((r) => r.word === 'Not checked').map((r) => r.system).join(', ')}`] : []),
      ...rows.filter((r) => r.word === 'Check by hand').map((r) => `${r.system}: check by hand`),
    ].join('; ') }
  else if (open.length) { kind = 'GO WITH DEFERRALS'; word = goWithWord(open.length); reason = `${open.length === 1 ? 'one deferral is' : `${open.length} deferrals are`} open: the workaround ${open.length === 1 ? 'line is' : 'lines are'} below` }
  else { kind = 'GO'; word = 'GO'; reason = verdict.reason }
  return { word, kind, reason, rows, deferrals: open, deferralNote: input.deferralNote }
}

// ---- ticks (do-confirm) ----

/** The history key a system's tick is filed under. Not an issue's key: the board never shows it. */
export const tickKey = (system: System): string => `Foresight checklist · ${system}`

export { TICK_MINUTES, tickAt, type Tick } from '../board/ticks.ts'
import { tickAt, type Tick } from '../board/ticks.ts'

/**
 * The ticks on the system rows for `forMatch` ("after Q33", the board's label), as the board counts a tick: only this
 * event's (the board's own scope: its name and span, or its played time). With no session there is no event to tie them to: none are read.
 */
export function ticksFor(history: HistoryEvent[], robot: string, session: Session | null, forMatch: string, now: number): Map<System, Tick> {
  const out = new Map<System, Tick>()
  if (!session) return out
  const scope = scopeOf(session)
  const states = boardState(history)
  for (const system of SYSTEMS) {
    const c = (states.get(boardKey(tickKey(system), robot))?.checked ?? []).filter((x) => x.match === forMatch && inScope(x, scope)).at(-1)
    if (c) out.set(system, tickAt(c.by.role, c.when, now))
  }
  return out
}

// ---- the practice-start checklist ----

/**
 * The fixed order: battery, CAN (every device present and healthy), cameras, zeros; then the rest of the live checks in the
 * team's own order. Lines are the team's, unmerged, so "n left" names each one.
 */
export const PRACTICE_FIRST: { group: string; lines: string[] }[] = [
  { group: 'Battery', lines: ['Fresh battery installed'] },
  { group: 'CAN', lines: ['All device values updating', "All CAN devices licensed and ID'd", 'CTRE devices healthy'] },
  { group: 'Cameras', lines: ['All cameras on and detecting AprilTags'] },
  { group: 'Zeros', lines: ['Mechanisms zeroed'] },
]

export interface PracticeItem { group: string; line: MarkedLine; done: boolean }

export interface PracticeChecklist {
  items: PracticeItem[]
  /** Lines only a person can check, context that is never a fault, and lines this robot's code can never report: shown folded, never counted. */
  byEye: MarkedLine[]
  /** Lines not done. */
  left: PracticeItem[]
  /** What is left as actions: the lines waiting on the robot snapshot are one ("drop the snapshot"). */
  actions: string[]
  ready: boolean
  /** "Ready to drive" or "2 left: Fresh battery installed, drop the snapshot". Never a Go. */
  end: string
}

const WAITING_ON_SNAPSHOT = /^no robot snapshot/
/** A line that stays "not checked" because the robot's code never sends what it reads: only a person can do it. */
const NEVER_REPORTED = /check by hand|watches no CTRE device|the robot (does not|doesn't) send/

/** Failing (red or amber) items whose rule is on no line of the team's checklist: nothing in the list would show them. */
export function uncoveredItems(verdict: Pick<Verdict, 'items'> | null): VerdictItem[] {
  const covered = new Set(ONCHECKS.flatMap((l) => l.rules ?? []))
  return (verdict?.items ?? []).filter((i) => i.level !== 'grey' && !covered.has(i.finding.rule))
}

/**
 * `uncovered`: failing items that no checklist line covers (uncoveredItems): each is left, so "Ready to drive" never
 * reads over a live red or amber.
 */
export function practiceChecklist(lines: MarkedLine[], uncovered: VerdictItem[] = []): PracticeChecklist {
  const live = lines.filter((l) => !l.byEye && !l.context)
  const byHand = live.filter((l) => l.state === 'not checked' && NEVER_REPORTED.test(l.detail))
  const counted = live.filter((l) => !byHand.includes(l))
  const first = PRACTICE_FIRST.flatMap((g) => g.lines.map((name) => ({ group: g.group, line: counted.find((l) => l.line === name) })).filter((x): x is { group: string; line: MarkedLine } => !!x.line))
  const named = new Set(first.map((x) => x.line))
  const rest = counted.filter((l) => !named.has(l)).map((line) => ({ group: 'The rest', line }))
  const extra = uncovered.map((i) => ({
    group: 'Not on the checklist',
    line: { section: '', line: `${makerOf(i.finding.rule)?.title ?? i.finding.title} (no checklist line)`, state: i.level === 'red' ? 'red' : 'amber', detail: i.finding.title } as MarkedLine,
  }))
  const items = [...first, ...rest, ...extra].map((x): PracticeItem => ({ ...x, done: x.line.state === 'ok' }))
  const left = items.filter((i) => !i.done)
  const actions: string[] = []
  for (const i of left) {
    const name = WAITING_ON_SNAPSHOT.test(i.line.detail) ? 'drop the snapshot' : i.line.line
    if (!actions.includes(name)) actions.push(name)
  }
  return {
    items, left, actions, ready: left.length === 0, byEye: [...lines.filter((l) => l.byEye || l.context), ...byHand],
    end: left.length === 0 ? 'Ready to drive' : `${actions.length} left: ${actions.join(', ')}`,
  }
}
