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
import { buildBoard, inScope, mechanismOf, robotOf, type Board, type BoardIssue } from '../board/model.ts'
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

/** Every open (not closed, not ended) deferral for the robot. */
export function openDeferrals(board: Board, profile: RobotProfile): OpenDeferral[] {
  const robot = profileId(profile)
  return board.issues
    .filter((i): i is BoardIssue & { deferral: NonNullable<BoardIssue['deferral']> } => i.robot === robot && i.status === 'deferred' && !!i.deferral && !i.deferral.expired)
    .map((i) => ({ key: i.key, system: systemOf(i.rule, i.about, profile), title: rowTitle(i), workaround: i.deferral.workaround, until: i.deferral.point.until }))
}

// ---- the queue checklist ----

export type SystemWord = 'Go' | 'Go with deferral' | 'No-go' | 'Not checked'

export interface QueueRow {
  system: System
  word: SystemWord
  /** Reds with no deferral: what makes the system No-go. */
  fix: VerdictItem[]
  /** Ambers: to look at; they never move the word. */
  look: VerdictItem[]
  /** Open deferrals of this system, seen live or not. */
  deferrals: (OpenDeferral & { seenNow: boolean })[]
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

const WORD_RANK: Record<SystemWord, number> = { 'No-go': 0, 'Not checked': 1, 'Go with deferral': 2, Go: 3 }

/**
 * `verdict`: the engine's, or null with no current check. `deferrals`: null when none could be read (no event session),
 * with `deferralNote` saying why. `profile`: the robot's, for the grouping.
 */
export function queueChecklist(input: { verdict: Verdict | null; why: string; profile: RobotProfile | undefined; deferrals: OpenDeferral[] | null; deferralNote: string | null }): QueueChecklist {
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
    const word: SystemWord = fix.length ? 'No-go' : unjudged ? 'Not checked' : deferrals.length ? 'Go with deferral' : 'Go'
    const text = word === 'No-go' ? `No-go: ${fix.map((i) => i.finding.title).join('; ')}`
      : word === 'Go with deferral' ? `Go with deferral: ${deferrals.map((d) => `${d.title} · workaround: ${d.workaround || 'none written'}`).join('; ')}`
      : word === 'Not checked' ? (verdict ? 'Not checked: a check for this system could not read its signals' : 'Not checked') : 'Go'
    return { system, word, fix, look: mine.filter((i) => i.level === 'amber'), deferrals, text }
  }).sort((a, b) => WORD_RANK[a.word] - WORD_RANK[b.word] || SYSTEMS.indexOf(a.system) - SYSTEMS.indexOf(b.system))
  const nogo = rows.filter((r) => r.word === 'No-go')
  let word: string
  let kind: QueueKind
  let reason: string
  if (nogo.length) { kind = 'NO-GO'; word = 'NO-GO'; reason = `${nogo.length} ${nogo.length === 1 ? 'system' : 'systems'} to fix before the robot goes on the field: ${nogo.map((r) => r.system).join(', ')}` }
  else if (!verdict || verdict.verdict === 'NOT CHECKED') { kind = 'NOT CHECKED'; word = 'NOT CHECKED'; reason = verdict ? verdict.reason : input.why }
  else if (open.length) { kind = 'GO WITH DEFERRALS'; word = goWithWord(open.length); reason = `${open.length === 1 ? 'one deferral is' : `${open.length} deferrals are`} open: the workaround ${open.length === 1 ? 'line is' : 'lines are'} below` }
  else { kind = 'GO'; word = 'GO'; reason = verdict.reason }
  return { word, kind, reason, rows, deferrals: open, deferralNote: input.deferralNote }
}

// ---- ticks (do-confirm) ----

/** The history key a system's tick is filed under. Not an issue's key: the board never shows it. */
export const tickKey = (system: System): string => `Foresight checklist · ${system}`

export interface Tick { role: string; when: string }

/**
 * The ticks on the system rows for `forMatch` ("after Q33", the board's label), as the board counts a tick: only this
 * event's (its name and span, or its played time). With no session there is no event to tie them to: none are read.
 */
export function ticksFor(history: HistoryEvent[], robot: string, session: Session | null, forMatch: string): Map<System, Tick> {
  const out = new Map<System, Tick>()
  if (!session) return out
  const times = session.matches.map((m) => m.playedAt).filter((x): x is number => x !== null)
  const scope = { event: session.matches.find((m) => m.onField && m.event)?.event ?? '', from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null }
  const states = boardState(history)
  for (const system of SYSTEMS) {
    const c = (states.get(boardKey(tickKey(system), robot))?.checked ?? []).filter((x) => x.match === forMatch && inScope(x, scope)).at(-1)
    if (c) out.set(system, { role: c.by.role, when: c.when })
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
  /** Lines only a person can check, and context that is never a fault: shown folded, never counted. */
  byEye: MarkedLine[]
  left: PracticeItem[]
  ready: boolean
  /** "Ready to drive" or "3 left: Fresh battery installed, …". Never a Go. */
  end: string
}

export function practiceChecklist(lines: MarkedLine[]): PracticeChecklist {
  const live = lines.filter((l) => !l.byEye && !l.context)
  const first = PRACTICE_FIRST.flatMap((g) => g.lines.map((name) => ({ group: g.group, line: live.find((l) => l.line === name) })).filter((x): x is { group: string; line: MarkedLine } => !!x.line))
  const named = new Set(first.map((x) => x.line))
  const rest = live.filter((l) => !named.has(l)).map((line) => ({ group: 'The rest', line }))
  const items = [...first, ...rest].map((x): PracticeItem => ({ ...x, done: x.line.state === 'ok' }))
  const left = items.filter((i) => !i.done)
  return {
    items, left, ready: left.length === 0, byEye: lines.filter((l) => l.byEye || l.context),
    end: left.length === 0 ? 'Ready to drive' : `${left.length} left: ${left.map((i) => i.line.line).join(', ')}`,
  }
}
