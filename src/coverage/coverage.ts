/**
 * The Logging tab: every signal the robot profile expects, whether this log has it (and fast enough), and which checks
 * went dark without it. It only reads the log and the report; it never changes what a rule finds, and
 * meta/not-checked (rules/run.ts) stays as it is.
 *
 * The list starts from profileKeys (the keys that tell robots apart) and adds the profile's other slots: the battery
 * tracker, each camera's stale flag and raw result, other devices, zeroing, the state machine, CAN bus members, alert
 * groups and three AdvantageKit keys rules read (e-stop, match clock, auto chooser).
 */
import { firstPresent, num, type Match } from '../match/match.ts'
import type { NumberSeries } from '../match/series.ts'
import { profileKeys } from '../profiles/choose.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { RULES, ruleById, type Report } from '../rules/index.ts'
import { stripRepoPaths } from '../report/repo-paths.ts'
import type { Severity } from '../rules/rule.ts'
import type { MatchSummary } from '../session/summary.ts'
import { sampleRate, SLOW_HZ, words } from '../rules/view.ts'

export type CoverageState = 'logged' | 'slow' | 'never changes' | 'not logged' | 'profile gap'

/** One signal the profile expects. */
export interface CoverageKey {
  /** The signal in words: "Front Left drive supply current". */
  what: string
  /** The key the profile expects; null when the profile names none. */
  key: string | null
  /** Other keys the profile accepts for it (the battery tracker's keys moved between versions). */
  alternatives?: string[]
  /** It must be logged at least this often while enabled (Hz) for short dips and spikes to show. */
  hz?: number
  /** It changes all the time on a working robot, so one value for a whole enabled log means it isn't being read. */
  varies?: boolean
  /** The name rules give it in their "logged slowly" notes (view.ts labels). */
  label?: string
}

/** A check that couldn't run, or ran only partly, because of this signal. */
export interface DarkCheck {
  rule: string
  title: string
  severity: Severity
  /** What the check exists to catch (the rule's `incident`). */
  incident: string
  partly: boolean
}

export interface CoverageLine extends CoverageKey {
  state: CoverageState
  /** The key found in the log (one of key and alternatives). */
  found?: string
  /** How often it was logged while enabled (Hz), when that was judged. */
  measuredHz?: number
  dark: DarkCheck[]
  /** What to do about it, in words: the signal and the key, never the code. Empty when it is logged. */
  todo: string
}

export interface Coverage {
  lines: CoverageLine[]
  /** Set when the robot profile doesn't fit the log: most rules about the robot were not run at all. */
  misfit: string | null
}

/**
 * Battery voltage and motor supply current feed the power model's 50 Hz grid (power/battery-model.ts). Measured on 729
 * of these keys in 141 local logs (2026-10-19): 666 log at 49.5 Hz or more, 22 at 45–49.5 Hz (one robot loop of
 * jitter on short enables, judged fine) and 41 below 45 Hz (logs the profile fits). So "slow" is under 90 % of this
 * bar. Other measured keys use SLOW_HZ as it is, the line the rules' own "logged slowly" notes use.
 */
const POWER_HZ = 50
const RATE_SLACK = 0.9
/** Signals that change on every loop of a working robot (a frozen value means the reading stopped). */
const VARYING = ['batteryVoltage', 'gyroPitch', 'gyroRoll', 'accelX', 'accelY', 'loopCycleMs']
/** AdvantageKit keys profileKeys leaves out (every AdvantageKit log has them) that rules read. */
const RULE_READS = ['emergencyStop', 'matchTimeLeft', 'autoChoice'] as const

/** Every signal the profile expects, labelled, starting from profileKeys. */
export function coverageKeys(profile: RobotProfile): CoverageKey[] {
  const signals = signalSlots(profile)
  const others = otherSlots(profile)
  // A key some slots share (a motor's stator current is also its zeroing current) keeps its first slot, as dedupe does.
  const byKey = new Map<string, CoverageKey>()
  for (const slot of [...signals, ...others]) if (slot.key && !byKey.has(slot.key)) byKey.set(slot.key, slot)
  const fromProfileKeys = profileKeys(profile).map((k) => byKey.get(k) ?? { what: k, key: k })
  // profileKeys leaves out empty slots, the keys every log has, and the AdvantageKit keys every robot logs; rules
  // still read the last ones.
  const empty = signals.filter((x) => !x.key)
  const ruleReads = RULE_READS.map((name) => signals.find((x) => x.what === words(name))!)
  return dedupe([...fromProfileKeys, ...empty, ...ruleReads, ...others])
}

/** The profile's single signals (`signals`, without the lists), labelled. */
function signalSlots(p: RobotProfile): CoverageKey[] {
  const s = p.signals
  const names = (Object.keys(s) as (keyof typeof s)[]).filter((n) => typeof s[n] === 'string')
  return names.map((name) => ({
    what: words(name),
    key: (s[name] as string) || null,
    hz: name === 'batteryVoltage' ? POWER_HZ : undefined,
    varies: VARYING.includes(name) || undefined,
    label: name === 'batteryVoltage' ? 'battery voltage' : undefined,
  }))
}

/** Everything else the profile names, in the order a student reads the profile file. */
function otherSlots(p: RobotProfile): CoverageKey[] {
  return [
    ...p.signals.alertGroups.map((g) => ({ what: `alerts in ${g}`, key: `${g}/errors`, alternatives: [`${g}/warnings`, `${g}/infos`] })),
    ...p.motorGroups.flatMap((g) => g.motors.flatMap((m) => [
      { what: `${m.name} supply current`, key: m.supplyCurrent ?? null, hz: POWER_HZ, label: `${m.name} supply` },
      { what: `${m.name} stator current`, key: m.statorCurrent ?? null, hz: SLOW_HZ, label: `${m.name} stator` },
      { what: `${m.name} velocity`, key: m.velocity ?? null, hz: SLOW_HZ, label: m.name },
      { what: `${m.name} Connected flag`, key: m.connected ?? null },
      { what: `${m.name} temperature`, key: m.temperature ?? null },
    ].filter((x) => x.key))),
    ...p.cameras.flatMap((c) => [
      { what: `${c.name} accepted pose`, key: c.acceptedPose },
      { what: `${c.name} connected`, key: c.connected },
      { what: `${c.name} stale flag`, key: c.stale },
      { what: `${c.name} PhotonVision result`, key: c.result ?? null },
    ].filter((x) => x.key)),
    ...p.otherDevices.map((d) => ({ what: `${d.name} connected`, key: d.connected })),
    ...batterySlots(p.battery),
    ...p.zeroing.flatMap((z) => [
      { what: `${z.mechanism} position`, key: z.position },
      ...(z.zeroCurrent ? [{ what: `${z.mechanism} zeroing stator current`, key: z.zeroCurrent.statorCurrent }] : []),
    ]),
    ...stateMachineSlots(p.stateMachine),
    ...(p.canBuses ?? []).flatMap((b) => b.members.map((m) => ({ what: `${m.name} health (${b.name})`, key: m.key }))),
  ]
}

const BATTERY_WORDS: Record<keyof RobotProfile['battery'], string> = {
  id: 'battery ID', idSource: 'battery ID source', gaugeValid: 'battery gauge valid flag',
  effectiveCapacityAh: 'battery effective capacity', ratedCapacityAh: 'battery rated capacity',
  remainingChargePct: 'battery remaining charge', numCycles: 'battery charge cycles',
}

function batterySlots(battery: RobotProfile['battery']): CoverageKey[] {
  return (Object.keys(BATTERY_WORDS) as (keyof RobotProfile['battery'])[]).map((name) => {
    const [key = null, ...alternatives] = battery[name]
    return { what: BATTERY_WORDS[name], key, alternatives: alternatives.length ? alternatives : undefined }
  })
}

function stateMachineSlots(sm: RobotProfile['stateMachine']): CoverageKey[] {
  if (!sm) return []
  return [
    { what: `${sm.name} state`, key: sm.state },
    ...sm.requests.map((r) => ({ what: `${sm.name}: ${r.name}`, key: r.key })),
    ...sm.sensors.map((x) => ({ what: `${sm.name}: ${x.name}`, key: x.key })),
  ]
}

/** One line per key (the first label wins), and one per empty slot. */
function dedupe(slots: CoverageKey[]): CoverageKey[] {
  const seen = new Set<string>()
  return slots.filter((s) => {
    const id = s.key ?? `gap:${s.what}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** The Logging tab for one match: each expected signal's state and the checks that went dark without it. */
export function coverage(match: Match, report: Report): Coverage {
  const reasons = report.skipped.map((s) => ({ rule: s.rule, partly: s.reason.startsWith('partly'), parts: parts(s.reason) }))
  const lines = coverageKeys(match.profile).map((slot) => lineFor(slot, match, reasons))
  lines.push(...unlistedLines(lines, reasons))
  const misfit = match.profileChoice.misfit ? match.profileChoice.note : null
  return { lines: lines.sort(byUrgency), misfit }
}

interface Reason { rule: string; partly: boolean; parts: string[] }

/** A skip reason split into its parts, each without the motor/camera name in front ("Left: missing /X" → "missing /X"). */
function parts(reason: string): string[] {
  return reason.replace(/^partly checked; /, '').split('; ').map((p) => p.replace(/^[^/:;]+: (?=missing |\S.* (?:is|are) logged about )/, ''))
}

function lineFor(slot: CoverageKey, match: Match, reasons: Reason[]): CoverageLine {
  const { state, found, measuredHz } = stateOf(slot, match)
  const dark = reasons
    .filter((r) => r.parts.some((p) => namesSlot(p, slot, state)))
    .map((r) => darkCheck(r.rule, r.partly || state === 'slow'))
  return { ...slot, state, found, measuredHz, dark, todo: todoFor(slot, state, measuredHz) }
}

function stateOf(slot: CoverageKey, match: Match): { state: CoverageState; found?: string; measuredHz?: number } {
  if (!slot.key) return { state: 'profile gap' }
  const found = firstPresent(match, [slot.key, ...(slot.alternatives ?? [])])
  if (!found) return { state: 'not logged' }
  // Rate and frozen values only mean something while the robot was enabled.
  if (match.enabled.length === 0 || (!slot.hz && !slot.varies)) return { state: 'logged', found }
  const series = num(match, found)
  if (!series || series.v.length === 0) return { state: 'logged', found }
  if (slot.varies && neverChanges(series)) return { state: 'never changes', found }
  const rate = slot.hz ? sampleRate(series, match.enabled) : null
  if (rate && slot.hz && rate.fastHz < barFor(slot.hz)) return { state: 'slow', found, measuredHz: rate.fastHz }
  return { state: 'logged', found, measuredHz: rate?.fastHz }
}

/** Under this rate a key is slow: the 50 Hz power bar less one loop of jitter; the 30 Hz bar exactly as the rules' notes use it. */
function barFor(hz: number): number {
  return hz === POWER_HZ ? RATE_SLACK * hz : hz
}

function neverChanges(series: NumberSeries): boolean {
  return series.v.every((v) => v === series.v[0])
}

/** Does this part of a skip reason name the slot: its key missing, its label logged slowly, or its empty profile slot? */
function namesSlot(part: string, slot: CoverageKey, state: CoverageState): boolean {
  const missing = /^missing (.+)$/.exec(part)?.[1]
  if (missing !== undefined) {
    if (state === 'profile gap') return missing === `${slot.what} (the robot profile has no key for it)`
    return [slot.key, ...(slot.alternatives ?? [])].includes(missing)
  }
  const slow = /^(.+?) (?:is|are) logged about /.exec(part)?.[1]
  return slow !== undefined && !!slot.label && slow.split(/, | and /).includes(slot.label)
}

/**
 * Lines only a rule's reason names: an empty profile slot ("the robot profile names no state machine", a motor with
 * no stator key), or a missing key no line expects.
 */
function unlistedLines(lines: CoverageLine[], reasons: Reason[]): CoverageLine[] {
  const added = new Map<string, CoverageLine>()
  const add = (id: string, line: Omit<CoverageLine, 'dark'>, dark: DarkCheck) => {
    const kept = added.get(id) ?? { ...line, dark: [] }
    if (!kept.dark.some((d) => d.rule === dark.rule)) kept.dark.push(dark)
    added.set(id, kept)
  }
  for (const r of reasons) {
    for (const p of r.parts) {
      const what = gapIn(p)
      const key = /^missing (\/.+|[A-Z]+:.+)$/.exec(p)?.[1]
      if (what !== null && !lines.some((l) => l.state === 'profile gap' && l.what === what)) {
        add(`gap:${what}`, { what, key: null, state: 'profile gap', todo: todoFor({ what, key: null }, 'profile gap') }, darkCheck(r.rule, r.partly))
      } else if (key && !lines.some((l) => [l.key, ...(l.alternatives ?? [])].includes(key))) {
        add(key, { what: key, key, state: 'not logged', todo: `Log ${key}.` }, darkCheck(r.rule, r.partly))
      }
    }
  }
  return [...added.values()]
}

/** The empty profile slot a reason names, in words, or null. */
function gapIn(part: string): string | null {
  const none = /^the robot profile (?:names|maps|lists) no (.+)$/.exec(part)?.[1]
  if (none) return none
  return /^missing (.+) \((?:not in the robot profile|the robot profile has no key for it|the robot profile has none|the robot profile names no [^)]*)\)$/.exec(part)?.[1] ?? null
}

function darkCheck(id: string, partly: boolean): DarkCheck {
  const rule = ruleById(id)
  return { rule: id, title: rule?.title ?? id, severity: rule?.severity ?? 'info', incident: stripRepoPaths(rule?.incident ?? ''), partly }
}

function todoFor(slot: CoverageKey, state: CoverageState, hz?: number): string {
  switch (state) {
    case 'logged':
      return ''
    case 'not logged':
      return `Log ${slot.what} as ${slot.key}.`
    case 'slow':
      return `Log ${slot.what} on every robot loop: it was logged about ${Math.round(hz ?? 0)} times a second while enabled, and the checks need ${slot.hz}.`
    case 'never changes':
      return `${slot.what} logged one value for the whole log, though the robot was enabled: check that it is read from the device on every loop.`
    case 'profile gap':
      return `Fix the robot profile (src/profiles/): it has no key for ${slot.what}. If the robot logs it, add the key; this is not a robot-code change.`
  }
}

const STATE_ORDER: Record<CoverageState, number> = { 'not logged': 0, 'profile gap': 1, slow: 2, 'never changes': 3, logged: 4 }
const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Lines behind the checks that guard the match first (worst severity, then the rule's place in RULES), then by state. */
function byUrgency(a: CoverageLine, b: CoverageLine): number {
  return urgency(a) - urgency(b) || STATE_ORDER[a.state] - STATE_ORDER[b.state]
}

function urgency(line: CoverageLine): number {
  if (line.dark.length === 0) return Infinity
  return Math.min(...line.dark.map((d) => SEVERITY_ORDER[d.severity] * 1000 + rulePlace(d.rule)))
}

function rulePlace(id: string): number {
  const i = RULES.findIndex((r) => r.id === id)
  return i < 0 ? RULES.length : i
}

/** A signal's state in one match, as a session keeps it. */
export interface LoggedState { what: string; key: string | null; state: CoverageState }

/** One stretch of matches, in the order they were played, in which a signal kept the same state. */
export interface StateRun { state: CoverageState; first: MatchSummary; last: MatchSummary; matches: number }

/**
 * For each signal whose state changed across the session (it appeared, vanished, slowed down), the stretches of
 * matches in each state, oldest first. Matches summarized before Hindsight kept logging states are left out.
 */
export function loggingChanges(matches: MatchSummary[]): { what: string; key: string | null; runs: StateRun[] }[] {
  const byId = new Map<string, { what: string; key: string | null; runs: StateRun[] }>()
  for (const m of matches) {
    for (const s of m.logging ?? []) {
      const id = s.key ?? `gap:${s.what}`
      const entry = byId.get(id) ?? { what: s.what, key: s.key, runs: [] }
      const run = entry.runs.at(-1)
      if (run && run.state === s.state) Object.assign(run, { last: m, matches: run.matches + 1 })
      else entry.runs.push({ state: s.state, first: m, last: m, matches: 1 })
      byId.set(id, entry)
    }
  }
  return [...byId.values()].filter((e) => e.runs.length > 1)
}

/** The signals not logged (or with no key in the profile) in every match of the session that kept logging states. */
export function neverLogged(matches: MatchSummary[]): LoggedState[] {
  const kept = matches.filter((m) => m.logging)
  if (kept.length === 0) return []
  const gaps = (m: MatchSummary) => (m.logging ?? []).filter((s) => s.state === 'not logged' || s.state === 'profile gap')
  const id = (s: LoggedState) => s.key ?? `gap:${s.what}`
  return gaps(kept[0]).filter((s) => kept.every((m) => gaps(m).some((x) => id(x) === id(s))))
}

/** One match recorded in several logs: each signal at its worst state across the pieces (a gap in any piece is a gap). */
export function worstAcross(pieces: (LoggedState[] | undefined)[]): LoggedState[] | undefined {
  if (pieces.some((p) => !p)) return undefined
  const worst = new Map<string, LoggedState>()
  for (const s of pieces.flatMap((p) => p ?? [])) {
    const id = s.key ?? `gap:${s.what}`
    const kept = worst.get(id)
    if (!kept || STATE_ORDER[s.state] < STATE_ORDER[kept.state]) worst.set(id, s)
  }
  return [...worst.values()]
}
