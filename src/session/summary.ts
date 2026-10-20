/**
 * One match boiled down to what a session view needs: when it was played, what each rule said, and a few numbers
 * per match for trends. The raw log is dropped after this, so hundreds of logs fit in memory.
 */

import { analyzeFiles, analyzeFilesWithCode, type AnalyzeResult, type InputFile } from '../analyze.ts'
import type { CodeFolder } from '../code/limit-lines.ts'
import { has, num, values, type Match } from '../match/match.ts'
import { heldAt } from '../match/series.ts'
import { MatchView } from '../rules/view.ts'
import { worstFollowerSecondsOff } from '../rules/mech/follower-trace.ts'
import { powerReport } from '../power/power-report.ts'
import { RULES, type Report } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import type { Pose2d } from '../readers/wpilog.ts'
import type { CodePin, RobotProfile } from '../profiles/types.ts'
import { profileFit, type ProfileChoice } from '../profiles/choose.ts'
import { profileId } from '../profiles/index.ts'
import { coverage, worstAcross, type LoggedState } from '../coverage/coverage.ts'

/**
 * The shape of a saved MatchSummary. Summaries saved in the browser by an older Hindsight are still shown while their
 * shape is the same as this one's. Bump it whenever MatchSummary changes in a way old code can't be drawn from
 * (a field renamed or removed, a meaning changed); adding an optional field doesn't need it.
 */
export const SUMMARY_SHAPE = 2

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
  robot: { profileId: string; name: string; code: CodePin; how: ProfileChoice['how']; note: string | null; present: number; total: number }
  /** When one match was recorded in several logs (the robot program restarted mid-match): every log's file name. */
  pieces?: string[]
  /** Each signal the robot profile expects and its state in this log (the Logging tab). Absent in older summaries. */
  logging?: LoggedState[]
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
}

/** Before FRC robots logged with AdvantageKit's dated names, a clock this early is certainly unset. */
const EARLIEST_PLAUSIBLE = Date.UTC(2023, 0, 1)
/** A roboRIO 2 whose clock was never set reads its image date, 2024-12-18: treat that day (± 1) as unset. */
const UNSET_CLOCK_DAY = Date.UTC(2024, 11, 18)

/** Analyse one log and keep only the summary. `profile`: the robot the student chose for it, if any. */
export function summarizeLog(file: InputFile, profile?: RobotProfile, profiles?: RobotProfile[]): MatchSummary | null {
  // As the student's choice (checked for fit), not as a pinned profile.
  return summaryOf(analyzeFiles([file], profile ? () => profile : undefined, profiles), file)
}

/**
 * The same, with the robot code (src/code/limit-lines.ts); `codeName` names it in the summary. A summary where GitHub
 * couldn't answer (offline, its hour used up) isn't stamped with the code's name, so it is read again next time rather
 * than reused.
 */
export async function summarizeLogWithCode(file: InputFile, code: CodeFolder | null, codeName: string | null, profile?: RobotProfile, profiles?: RobotProfile[]): Promise<MatchSummary | null> {
  const result = await analyzeFilesWithCode([file], code, profile ? () => profile : undefined, profiles)
  const s = summaryOf(result, file)
  const askAgain = [...(result.analyses[0]?.match.limitLines?.values() ?? [])].some((a) => a.verdict === 'unknown' && a.tryAgain)
  if (s && code && !askAgain) s.codeFolder = codeName
  return s
}

function summaryOf({ analyses, problems }: AnalyzeResult, file: InputFile): MatchSummary | null {
  const a = analyses[0]
  if (!a) return null
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
  const idKey = has(match, match.profile.battery.id) ? match.profile.battery.id : null
  const ids = idKey ? values<string>(match, idKey) : null
  const atStart = ids && match.matchStart !== null ? heldAt(ids, match.matchStart) : undefined
  return {
    fileName: match.fileName, fileSize, ...when,
    event: match.event, matchLabel: match.matchLabel, matchType: matchTypeOf(match), onField: match.fms,
    batteryId: atStart || null,
    build: { sha: match.build.sha.slice(0, 7), branch: match.build.branch, uncommitted: /uncommitted/i.test(match.build.dirty) },
    rules, metrics: metrics(match), timing, problems: [],
    robot: robotOf(match),
    logging: coverage(match, report).lines.map((l) => ({ what: l.what, key: l.key, state: l.state })),
  }
}

function robotOf(match: Match): MatchSummary['robot'] {
  const fit = match.profileChoice.fit ?? profileFit(match.log, match.profile)
  return {
    profileId: profileId(match.profile), name: match.profile.name, code: match.profile.code,
    how: match.profileChoice.how, note: match.profileChoice.note, ...fit,
  }
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
    },
    timing: { parseMs: sum(pieces.map((p) => p.timing.parseMs)), rulesMs: sum(pieces.map((p) => p.timing.rulesMs)) },
    problems: pieces.flatMap((p) => p.problems),
    robot: pieces.reduce((a, b) => (b.robot.present / b.robot.total < a.robot.present / a.robot.total ? b : a)).robot,
    pieces: pieces.map((p) => p.fileName),
    logging: worstAcross(pieces.map((p) => p.logging)),
  }
}

/** When the match was played: the robot clock if it was set, else the date in an AdvantageKit file name. */
export function playedAt(match: Match): Pick<MatchSummary, 'playedAt' | 'playedAtSource' | 'clockNote'> {
  const fromName = dateFromFileName(match.fileName)
  const start = match.matchStart ?? match.logStart
  const fromClock = match.epochOffset !== null ? (match.epochOffset + start) * 1000 : null
  const clockOk = fromClock !== null && fromClock >= EARLIEST_PLAUSIBLE && Math.abs(fromClock - UNSET_CLOCK_DAY) > 86400e3
  if (clockOk && (fromName === null || Math.abs(fromClock - fromName) < 2 * 86400e3)) {
    return { playedAt: fromClock, playedAtSource: 'robot clock', clockNote: null }
  }
  if (fromName !== null) {
    return {
      playedAt: fromName, playedAtSource: 'file name',
      clockNote: clockOk ? 'The robot clock disagrees with the file name by more than 2 days; using the file name.' : 'The robot clock was not set; the date comes from the file name.',
    }
  }
  return { playedAt: null, playedAtSource: 'unknown', clockNote: 'The robot clock was not set and the file name has no date: put this log in a session by hand.' }
}

/** AdvantageKit names logs akit_YY-MM-DD_HH-MM-SS…; read that as UTC (AdvantageKit uses the roboRIO's UTC clock). */
export function dateFromFileName(name: string): number | null {
  const m = /(\d{2})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const t = Date.UTC(2000 + y, mo - 1, d, h, mi, s)
  return Number.isFinite(t) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? t : null
}

function metrics(match: Match): MatchMetrics {
  const p = powerReport(match)
  return {
    minVolts: p && Number.isFinite(p.minVolts) ? p.minVolts : null,
    secondsUnder7: p ? p.secondsUnder7 : null,
    chargeAh: p ? p.chargeAh : null,
    resistanceMilliohms: p?.resistanceOhms ? p.resistanceOhms * 1000 : null,
    followerSecondsOff: followerSecondsOff(match),
    brownoutVolts: p && Number.isFinite(p.brownoutVolts) ? p.brownoutVolts : null,
    loopOverrunPct: loopOverrun(match),
    visionOutlierPct: visionOutliers(match),
  }
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
  let worst: number | null = null
  for (const cam of match.profile.cameras) {
    if (!has(match, cam.acceptedPose)) continue
    const poses = values<Pose2d>(match, cam.acceptedPose)!
    let n = 0, far = 0
    poses.v.forEach((pose, i) => {
      const t = poses.t[i]
      if (t < match.matchStart! || t > match.matchEnd!) return
      const o = heldAt(odo, t)
      if (!o) return
      n++
      if (Math.hypot(pose.x - o.x, pose.y - o.y) > 0.5) far++
    })
    if (n) worst = Math.max(worst ?? 0, (100 * far) / n)
  }
  return worst
}
