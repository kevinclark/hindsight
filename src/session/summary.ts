/**
 * One match boiled down to what a session view needs: when it was played, what each rule said, and a few numbers
 * per match for trends. The raw log is dropped after this, so hundreds of logs fit in memory.
 */

import { analyzeFiles, analyzeFilesWithCode, powerMapInstant, type AnalyzeResult, type InputFile } from '../analyze.ts'
import { powerMapAt, powerMapStamp } from '../power/power-map.ts'
import type { HistoryEvent } from '../triage/history.ts'
import type { CodeFolder } from '../code/limit-lines.ts'
import { has, num, values, type Match } from '../match/match.ts'
import { heldAt } from '../match/series.ts'
import { batteryAt } from '../match/battery-id.ts'
import { isUncommitted } from '../match/git-dirty.ts'
import { MatchView } from '../rules/view.ts'
import { worstFollowerSecondsOff } from '../rules/mech/follower-trace.ts'
import { powerReport } from '../power/power-report.ts'
import { buildDrag, type MotorDrag } from '../power/drag.ts'
import { buildPowerGrid } from '../power/battery-model.ts'
import { chargedPastHealthyCurve, furthestBelowHealthy } from '../rules/power/battery-health.ts'
import { RULES, type Report } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import type { Pose2d } from '../readers/wpilog.ts'
import type { CodePin, RobotProfile } from '../profiles/types.ts'
import { namesRobot, PROFILE_FIT_MIN, profileFit, robotName, type ProfileChoice } from '../profiles/choose.ts'
import { profileId } from '../profiles/index.ts'
import { coverage, worstAcross, type LoggedState } from '../coverage/coverage.ts'
import { playedAt } from '../match/played-at.ts'
import { formatOf } from '../profiles/formats.ts'

export { dateFromFileName, playedAt } from '../match/played-at.ts'

/**
 * The shape of a saved MatchSummary. Summaries saved in the browser by an older Hindsight are still shown while their
 * shape is the same as this one's. Bump it whenever MatchSummary changes in a way old code can't be drawn from
 * (a field renamed or removed, a meaning changed); adding an optional field doesn't need it (`runs` is one: a summary without it
 * shows as before, with the "Read again to update" cue).
 */
// 4: never-enabled logs read quiet for the rules that judge only enabled time (needsEnabled); now not checked.
export const SUMMARY_SHAPE = 4

export type RuleStatus = 'fired' | 'quiet' | 'not checked'

/**
 * A finding as a session keeps it: the words and numbers, without the plot or the rule's own text (meaning, causes,
 * next step), which are the same for every match; only what this log said about its causes, and a next step of its
 * own, are kept.
 */
export type SummaryFinding = Omit<Finding, 'plot' | 'meaning' | 'causes' | 'nextStep'> & {
  likely: string[]
  ruledOut: Record<string, string>
  /** Only when this log's next step differs from the rule's usual one. */
  nextStep?: string
  /** Set only by the team's history (triage/track-record.ts sessionWithMarks), never kept: marked "not a real problem" on this match. */
  wrongMark?: { reason: string; when: string }
}

export function toSummaryFinding(f: Finding, ruleNextStep: string | undefined): SummaryFinding {
  const { plot: _p, meaning: _m, causes, nextStep, ...rest } = f
  return {
    ...rest,
    likely: causes.filter((c) => c.likely).map((c) => c.id),
    ruledOut: Object.fromEntries(causes.filter((c) => c.ruledOut).map((c) => [c.id, c.ruledOut!])),
    ...(nextStep !== ruleNextStep ? { nextStep } : {}),
  }
}

export interface MatchSummary {
  fileName: string
  /** The robot-code folder the log was read with (src/code/limit-lines.ts); missing when it was read without one. */
  codeFolder?: string | null
  fileSize: number
  /** Wall-clock start (ms since 1970) and where it came from. Null when neither the robot clock nor the file name says. */
  /** The power map this log's breaker findings were judged with: the instant it was looked up at, and the map line's stamp ('none': no map). Absent in copies saved before it was kept (read as 'none'). */
  powerMap?: { at: string; stamp: string }
  playedAt: number | null
  playedAtSource: 'robot clock' | 'file name' | 'unknown'
  /** Why the date came from somewhere other than the robot clock, for the student to see. */
  clockNote: string | null
  event: string
  matchLabel: string
  /**
   * /DriverStation/MatchType as logged: 0 none, 1 practice, 2 qualification, 3 elimination. Null when the log has no
   * such signal. The Trends labels a log with no match number from it.
   */
  matchType?: number | null
  onField: boolean
  /** Battery ID logged at the start of the match (null until the robot code logs one). */
  batteryId: string | null
  rules: Record<string, { status: RuleStatus; reason?: string; findings: SummaryFinding[] }>
  metrics: MatchMetrics
  timing: { parseMs: number; rulesMs: number }
  problems: string[]
  /** The code build the log says it ran (/RealMetadata): sha, branch and whether it had uncommitted changes. Absent in summaries made before this was kept. */
  build?: { sha: string; branch: string; uncommitted: boolean }
  /** The robot profile used for this log, how it was picked, and how many of its signals are in the log. */
  robot: { profileId: string; name: string; code: CodePin; how: ProfileChoice['how']; note: string | null; present: number; total: number; misfit?: boolean; codebase?: string }
  /** When one match was recorded in several logs (the robot program restarted mid-match): every log's file name. */
  pieces?: string[]
  /** Each signal the robot profile expects and its state in this log (the Logging tab). Absent in older summaries. */
  logging?: LoggedState[]
  /**
   * The runs in the log (ADR 8): how many, how long each lasted (seconds, in time order), and how many performance findings
   * were dropped because they fell in a run under 10 s. On the field the FMS match is one run. A log never enabled has none.
   */
  runs?: { count: number; seconds: number[]; droppedShort: number }
}

export interface MatchMetrics {
  minVolts: number | null
  secondsUnder7: number | null
  chargeAh: number | null
  resistanceMilliohms: number | null
  /** Seconds the worst follower ran more than 15 % off its leader at steady speed: the number mech/follower-mismatch fires on (1 s). */
  followerSecondsOff: number | null
  /** The brownout setting the log recorded (V); power/margin's line is this + 1.0 V. Null when not logged. */
  brownoutVolts: number | null
  /** Share of loops over 20 ms in auto (where overruns concentrate), %. */
  loopOverrunPct: number | null
  /** Share of accepted vision poses more than 0.5 m from odometry, worst camera, %. */
  visionOutlierPct: number | null
  /**
   * Each motor's median stator current at a steady speed, per speed band (src/power/drag.ts). Optional, so a summary
   * saved before it shows as before; Session -> Trends compares one band across matches.
   */
  drag?: MotorDrag[]
  /**
   * How far the battery's estimated open-circuit voltage fell below a healthy battery's at the same charge drawn, at its
   * worst point (power/battery-collapse's number, V; negative: above), and at what charge (Ah). Optional, like `drag`.
   */
  belowHealthyVolts?: number | null
  belowHealthyAh?: number | null
  /** The match drew more charge than the healthy curve covers, so it was compared only up to the curve's end. */
  pastHealthyCurve?: boolean
}

/**
 * Analyse one log and keep only the summary. `profile`: the robot the student chose for it, if any. `beside`: its Driver
 * Station files (.dslog, .dsevents), read with it.
 */
export function summarizeLog(file: InputFile, profile?: RobotProfile, profiles?: RobotProfile[], history?: HistoryEvent[], beside: InputFile[] = []): MatchSummary | null {
  // As the student's choice (checked for fit), not as a pinned profile.
  return summaryOf(analyzeFiles([file, ...beside], profile ? () => profile : undefined, profiles, history), file)
}

/**
 * The same, with the robot code (src/code/limit-lines.ts); `codeName` names it in the summary. A summary where GitHub
 * couldn't answer (offline, its hour used up) isn't stamped with the code's name, so it is read again next time rather
 * than reused.
 */
export async function summarizeLogWithCode(file: InputFile, code: CodeFolder | null, codeName: string | null, profile?: RobotProfile, profiles?: RobotProfile[], history?: HistoryEvent[], beside: InputFile[] = []): Promise<MatchSummary | null> {
  const result = await analyzeFilesWithCode([file, ...beside], code, profile ? () => profile : undefined, profiles, history)
  const s = summaryOf(result, file)
  const askAgain = [...(result.analyses[0]?.match.limitLines?.values() ?? [])].some((a) => a.verdict === 'unknown' && a.tryAgain)
  if (s && code && !askAgain) s.codeFolder = codeName
  return s
}

/** What the Session view lists for a log made from a .hoot (formats.ts `runsNoRules`): no summary is made of one. */
export const HOOT_NOT_IN_SESSIONS = "read from a .hoot: open it in Match review. Sessions don't read .hoot data yet."

/**
 * The one place both `summarizeLog` and `summarizeLogWithCode` end, so a log whose type runs no rule gets no summary on any
 * path (and none is cached or reaches an event line). Thrown, so the Session view lists it as `<name>: <this>` among its
 * problems as it does any log it couldn't read.
 */
function summaryOf({ analyses, problems }: AnalyzeResult, file: InputFile): MatchSummary | null {
  const a = analyses[0]
  if (!a) return null
  if (formatOf(a.match.log)?.runsNoRules) throw new Error(HOOT_NOT_IN_SESSIONS)
  const s = summarizeMatch(a.match, a.report, file.bytes.length, a.timing)
  s.problems = problems
  return s
}

export function summarizeMatch(match: Match, report: Report, fileSize: number, timing = { parseMs: 0, rulesMs: 0 }): MatchSummary {
  const when = playedAt(match)
  const rules: MatchSummary['rules'] = {}
  for (const rule of RULES) {
    const skipped = report.skipped.find((s) => s.rule === rule.id)
    // A rule that crashed is a Hindsight bug and says nothing about the log: not checked, never quiet.
    const crashed = report.crashed.find((s) => s.rule === rule.id)
    const findings = report.findings.filter((f) => f.rule === rule.id)
    const fullySkipped = skipped && !skipped.reason.startsWith('partly')
    // Grey (info) findings are context, e.g. an alert seen only before the match: they don't count as "fired".
    const fired = findings.some((f) => f.severity !== 'info')
    rules[rule.id] = {
      status: fired ? 'fired' : fullySkipped || crashed ? 'not checked' : 'quiet',
      reason: crashed ? `crashed: ${crashed.reason}` : skipped?.reason,
      // Plots hold whole series; a session keeps only the words and numbers.
      findings: findings.map((f) => toSummaryFinding(f, rule.nextStep)),
    }
  }
  return {
    fileName: match.fileName, fileSize, ...when,
    powerMap: { at: powerMapInstant(match), stamp: powerMapStamp(match.powerMap) },
    event: match.event, matchLabel: match.matchLabel, matchType: matchTypeOf(match), onField: match.fms,
    batteryId: match.matchStart === null ? null : batteryAt(match, match.matchStart)?.id ?? null,
    build: { sha: match.build.sha.slice(0, 7), branch: match.build.branch, uncommitted: isUncommitted(match.build.dirty) },
    rules, metrics: metrics(match), timing, problems: [],
    robot: robotOf(match),
    logging: coverage(match, report).lines.map((l) => ({ what: l.what, key: l.key, state: l.state })),
    runs: { count: match.runs.length, seconds: match.runs.map((r) => Math.round((r.end - r.start) * 10) / 10), droppedShort: report.droppedInShortRuns?.length ?? 0 },
  }
}

/** The robot a Match was read with, as its summary names it (so a log's export keys a board issue the way the board does). */
export function matchRobot(match: Match): MatchSummary['robot'] { return robotOf(match) }
function robotOf(match: Match): MatchSummary['robot'] {
  const fit = match.profileChoice.fit ?? profileFit(match.log, match.profile)
  return {
    profileId: profileId(match.profile), name: match.profile.name, code: match.profile.code,
    how: match.profileChoice.how, note: match.profileChoice.note, ...fit,
    ...(match.profileChoice.misfit ? { misfit: true } : {}),
    ...(match.profileChoice.codebase ? { codebase: match.profileChoice.codebase } : {}),
  }
}

/**
 * The robot a summary is from, as the Session view and its report name and group it (profiles/choose.ts robotName): a
 * guess that doesn't fit goes by the log's code name. Older summaries have no misfit flag, so it is worked out from the fit.
 */
export function summaryRobot(r: MatchSummary['robot']): { key: string; name: string; named: boolean } {
  const pick = { how: r.how, misfit: r.misfit ?? r.present < PROFILE_FIT_MIN * r.total, codebase: r.codebase }
  const named = namesRobot(pick)
  return { key: named ? r.profileId : `code name ${r.codebase ?? ''}`, name: robotName(r.name, pick), named }
}

/** The robot as a board line names it: the profile id, or `summaryRobot()`'s name for a guess that does not fit. A log's export files its issues the same way. */
export function robotIdOf(r: MatchSummary['robot']): string {
  const s = summaryRobot(r)
  return s.named ? r.profileId : s.name
}

/**
 * One match recorded in several logs (the robot program restarted during it) as one summary: a rule fired if it fired
 * in any piece; lowest voltage is the lowest, time under 7 V and charge add up; the other numbers are the worst piece's.
 */
export function joinPieces(pieces: MatchSummary[]): MatchSummary {
  if (pieces.length === 1) return pieces[0]
  const [first] = pieces
  const rules: MatchSummary['rules'] = {}
  for (const id of Object.keys(first.rules)) {
    const all = pieces.map((p) => p.rules[id]).filter(Boolean)
    const status: RuleStatus = all.some((r) => r.status === 'fired') ? 'fired' : all.some((r) => r.status === 'quiet') ? 'quiet' : 'not checked'
    // The same issue in several pieces is one finding for the match: keep the worst (then the first) so one match
    // doesn't weigh 3× in the session's measured ranges.
    const byKey = new Map<string, SummaryFinding>()
    const rank = { error: 0, warning: 1, info: 2 }
    for (const f of all.flatMap((r) => r.findings)) {
      const kept = byKey.get(f.key)
      if (!kept || rank[f.severity] < rank[kept.severity]) byKey.set(f.key, f)
    }
    rules[id] = { status, reason: status === 'not checked' ? all.find((r) => r.reason)?.reason : undefined, findings: [...byKey.values()] }
  }
  const nums = (k: keyof MatchMetrics) => pieces.map((p) => p.metrics[k]).filter((v): v is number => v !== null)
  const pick = (k: keyof MatchMetrics, f: (xs: number[]) => number) => (nums(k).length ? f(nums(k)) : null)
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  // The line power/margin judged the lowest voltage against is the setting of the piece that had it.
  const lowest = pieces.filter((p) => p.metrics.minVolts !== null).reduce<MatchSummary | null>((a, b) => (a && a.metrics.minVolts! <= b.metrics.minVolts! ? a : b), null)
  return {
    ...first,
    fileSize: sum(pieces.map((p) => p.fileSize)),
    batteryId: pieces.find((p) => p.batteryId)?.batteryId ?? null,
    build: first.build ? { ...first.build, uncommitted: pieces.some((p) => p.build?.uncommitted) } : undefined,
    clockNote: pieces.find((p) => p.clockNote)?.clockNote ?? null,
    rules,
    metrics: {
      minVolts: pick('minVolts', (xs) => Math.min(...xs)),
      secondsUnder7: pick('secondsUnder7', sum),
      chargeAh: pick('chargeAh', sum),
      resistanceMilliohms: pick('resistanceMilliohms', (xs) => Math.max(...xs)),
      followerSecondsOff: pick('followerSecondsOff', (xs) => Math.max(...xs)),
      brownoutVolts: lowest?.metrics.brownoutVolts ?? null,
      loopOverrunPct: pick('loopOverrunPct', (xs) => Math.max(...xs)),
      visionOutlierPct: pick('visionOutlierPct', (xs) => Math.max(...xs)),
      // Each piece counts charge from its own start, so only the first piece is compared at the right charge drawn.
      ...(first.metrics.belowHealthyVolts !== undefined ? { belowHealthyVolts: first.metrics.belowHealthyVolts, belowHealthyAh: first.metrics.belowHealthyAh, pastHealthyCurve: first.metrics.pastHealthyCurve } : {}),
      ...(pieces.some((p) => p.metrics.drag?.length) ? { drag: joinDrag(pieces.map((p) => p.metrics.drag ?? [])) } : {}),
    },
    timing: { parseMs: sum(pieces.map((p) => p.timing.parseMs)), rulesMs: sum(pieces.map((p) => p.timing.rulesMs)) },
    problems: pieces.flatMap((p) => p.problems),
    // The worst-fitting piece's robot, with a code name from any piece (a piece cut short may not have logged it).
    robot: { codebase: pieces.find((p) => p.robot.codebase)?.robot.codebase, ...pieces.reduce((a, b) => (b.robot.present / b.robot.total < a.robot.present / a.robot.total ? b : a)).robot },
    pieces: pieces.map((p) => p.fileName),
    logging: worstAcross(pieces.map((p) => p.logging)),
    // The pieces of one match: their runs side by side (each piece started its own run).
    // A piece saved before runs existed has none: the joined match has them only when every piece does.
    runs: pieces.every((p) => p.runs) ? { count: sum(pieces.map((p) => p.runs!.count)), seconds: pieces.flatMap((p) => p.runs!.seconds), droppedShort: sum(pieces.map((p) => p.runs!.droppedShort)) } : undefined,
  }
}

/**
 * One match recorded in several logs: per motor (by group and name) and band, the seconds added and the amps the
 * seconds-weighted mean of the pieces' medians (a median of medians would weigh a 2 s piece like a 60 s one; the
 * pieces' samples are gone). A band under 2 s in every piece is lost even when the pieces together pass 2 s: bands
 * under 2 s are never stored.
 */
export function joinDrag(pieces: MotorDrag[][]): MotorDrag[] {
  const motors = new Map<string, MotorDrag & { sums: Map<number, { band: MotorDrag['bands'][number]; ampSeconds: number; seconds: number }> }>()
  for (const piece of pieces) {
    for (const d of piece) {
      const id = `${d.group}/${d.motor}`
      let m = motors.get(id)
      if (!m) motors.set(id, (m = { motor: d.motor, group: d.group, ...(d.unit ? { unit: d.unit } : {}), bands: [], sums: new Map() }))
      for (const b of d.bands) {
        const sum = m.sums.get(b.band) ?? { band: b, ampSeconds: 0, seconds: 0 }
        sum.ampSeconds += b.amps * b.seconds
        sum.seconds += b.seconds
        m.sums.set(b.band, sum)
      }
    }
  }
  return [...motors.values()].map(({ sums, ...m }) => ({
    ...m,
    bands: [...sums.values()].sort((a, b) => a.band.band - b.band.band).map((x) => ({ ...x.band, amps: x.ampSeconds / x.seconds, seconds: x.seconds })),
  }))
}

function metrics(match: Match): MatchMetrics {
  const p = powerReport(match)
  const drag = buildDrag(match)
  return {
    minVolts: p && Number.isFinite(p.minVolts) ? p.minVolts : null,
    secondsUnder7: p ? p.secondsUnder7 : null,
    chargeAh: p ? p.chargeAh : null,
    resistanceMilliohms: p?.resistanceOhms ? p.resistanceOhms * 1000 : null,
    followerSecondsOff: followerSecondsOff(match),
    brownoutVolts: p && Number.isFinite(p.brownoutVolts) ? p.brownoutVolts : null,
    loopOverrunPct: loopOverrun(match),
    visionOutlierPct: visionOutliers(match),
    ...(drag.some((d) => d.bands.length) ? { drag } : {}),
    ...belowHealthy(match, p?.resistanceOhms ?? null),
  }
}

/** power/battery-collapse's comparison with a healthy battery, as numbers (src/rules/power/battery-health.ts). */
function belowHealthy(match: Match, ohms: number | null): Pick<MatchMetrics, 'belowHealthyVolts' | 'belowHealthyAh' | 'pastHealthyCurve'> {
  const grid = buildPowerGrid(match)
  if (!grid || ohms === null) return {}
  const worst = furthestBelowHealthy(grid, ohms)
  if (!worst) return {}
  return { belowHealthyVolts: Math.round(worst.below * 100) / 100, belowHealthyAh: worst.ah, pastHealthyCurve: chargedPastHealthyCurve(grid, ohms) }
}

/** Seconds the worst follower ran more than 15 % off its leader: mech/follower-mismatch's own trace code. */
function followerSecondsOff(match: Match): number | null {
  return worstFollowerSecondsOff(new MatchView(match))
}

/** /DriverStation/MatchType as logged (last value), or null when the log has no such signal. */
function matchTypeOf(match: Match): number | null {
  const v = num(match, match.profile.signals.matchType)
  return v && v.v.length ? v.v[v.v.length - 1] : null
}

function loopOverrun(match: Match): number | null {
  const key = match.profile.signals.loopCycleMs
  if (!has(match, key) || match.auto.length === 0) return null
  const s = num(match, key)!
  let n = 0, over = 0
  for (let i = 0; i < s.t.length; i++) {
    if (!match.auto.some((iv) => s.t[i] >= iv.start && s.t[i] < iv.end)) continue
    n++
    if (s.v[i] > 20) over++
  }
  return n ? (100 * over) / n : null
}

function visionOutliers(match: Match): number | null {
  const odoKey = match.profile.signals.odometryPose
  if (!has(match, odoKey) || match.matchStart === null || match.matchEnd === null) return null
  const odo = values<Pose2d>(match, odoKey)!
  const view = new MatchView(match)
  let worst: number | null = null
  for (const cam of match.profile.cameras) {
    if (!has(match, cam.acceptedPose)) continue
    const poses = values<Pose2d>(match, cam.acceptedPose)!
    let n = 0, far = 0
    poses.v.forEach((pose, i) => {
      const t = poses.t[i]
      if (!view.inMatch(t)) return
      const o = heldAt(odo, t)
      if (!o) return
      n++
      if (Math.hypot(pose.x - o.x, pose.y - o.y) > 0.5) far++
    })
    if (n) worst = Math.max(worst ?? 0, (100 * far) / n)
  }
  return worst
}

/**
 * Whether the power map in effect for this summary's match is no longer the one its breaker findings were judged with
 * (the pit changed the breakers since): the summary holds findings, not the log, so it has to be read again.
 */
export function summaryMapStale(s: MatchSummary, history: readonly HistoryEvent[]): boolean {
  const now = powerMapStamp(powerMapAt(history, summaryRobotIds(s.robot), s.powerMap?.at ?? '9999-12-31T23:59:59.999Z'))
  return now !== (s.powerMap?.stamp ?? 'none')
}

/** The ids a power-map line for this summary's robot may carry: its key (name, or a kept profile's id) and the old "name @ branch" form. */
export function summaryRobotIds(r: MatchSummary['robot']): string[] {
  const builtIn = r.profileId === `${r.name} @ ${r.code.branch}`
  return builtIn ? [r.name, r.profileId] : [r.profileId]
}
