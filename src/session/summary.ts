/**
 * One match boiled down to what a session view needs: when it was played, what each rule said, and a few numbers
 * per match for trends. The raw log is dropped after this, so hundreds of logs fit in memory.
 */

import { analyzeFiles, type InputFile } from '../analyze.ts'
import { has, num, values, type Match } from '../match/match.ts'
import { heldAt, makeGrid, median, resample } from '../match/series.ts'
import { powerReport } from '../power/power-report.ts'
import { RULES, type Report } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import type { Pose2d } from '../readers/wpilog.ts'

export type RuleStatus = 'fired' | 'quiet' | 'not checked'

export interface MatchSummary {
  fileName: string
  fileSize: number
  /** Wall-clock start (ms since 1970) and where it came from. Null when neither the robot clock nor the file name says. */
  playedAt: number | null
  playedAtSource: 'robot clock' | 'file name' | 'unknown'
  /** Why the date came from somewhere other than the robot clock, for the student to see. */
  clockNote: string | null
  event: string
  matchLabel: string
  onField: boolean
  /** Battery ID logged at the start of the match (null until the robot code logs one). */
  batteryId: string | null
  rules: Record<string, { status: RuleStatus; reason?: string; findings: Finding[] }>
  metrics: MatchMetrics
  timing: { parseMs: number; rulesMs: number }
  problems: string[]
}

export interface MatchMetrics {
  minVolts: number | null
  secondsUnder7: number | null
  chargeAh: number | null
  resistanceMilliohms: number | null
  /** Worst follower's median speed as % of its leader, over steady running (100 = matched). */
  followerSpeedPct: number | null
  /** Share of loops over 20 ms in auto (where overruns concentrate), %. */
  loopOverrunPct: number | null
  /** Share of accepted vision poses more than 0.5 m from odometry, worst camera, %. */
  visionOutlierPct: number | null
}

/** Before FRC robots logged with AdvantageKit's dated names, a clock this early is certainly unset. */
const EARLIEST_PLAUSIBLE = Date.UTC(2023, 0, 1)
/** A roboRIO 2 whose clock was never set reads its image date, 2024-12-18: treat that day (± 1) as unset. */
const UNSET_CLOCK_DAY = Date.UTC(2024, 11, 18)

/** Analyse one log and keep only the summary. */
export function summarizeLog(file: InputFile): MatchSummary | null {
  const { analyses, problems } = analyzeFiles([file])
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
    const findings = report.findings.filter((f) => f.rule === rule.id)
    const fullySkipped = skipped && !skipped.reason.startsWith('partly')
    // Grey (info) findings are context, e.g. an alert seen only before the match: they don't count as "fired".
    const fired = findings.some((f) => f.severity !== 'info')
    rules[rule.id] = {
      status: fired ? 'fired' : fullySkipped ? 'not checked' : 'quiet',
      reason: skipped?.reason,
      // Plots hold whole series; a session keeps only the words and numbers.
      findings: findings.map((f) => ({ ...f, plot: undefined })),
    }
  }
  const idKey = match.profile.battery.id.find((k) => has(match, k))
  const ids = idKey ? values<string>(match, idKey) : null
  const atStart = ids && match.matchStart !== null ? heldAt(ids, match.matchStart) : undefined
  return {
    fileName: match.fileName, fileSize, ...when,
    event: match.event, matchLabel: match.matchLabel, onField: match.fms,
    batteryId: atStart || null,
    rules, metrics: metrics(match), timing, problems: [],
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
    followerSpeedPct: followerSpeed(match),
    loopOverrunPct: loopOverrun(match),
    visionOutlierPct: visionOutliers(match),
  }
}

/** Worst follower's median speed vs its leader at steady speed (same steady test as mech/follower-mismatch). */
function followerSpeed(match: Match): number | null {
  if (match.matchStart === null || match.matchEnd === null) return null
  const grid = makeGrid(match.matchStart, match.matchEnd, 0.02)
  let worst: number | null = null
  for (const g of match.profile.motorGroups.filter((x) => x.sameLoop)) {
    const keys = g.motors.map((m) => m.velocity).filter((k): k is string => !!k && has(match, k))
    if (keys.length < 2) continue
    const speeds = keys.map((k) => resample(num(match, k)!, grid).map(Math.abs))
    for (let k = 1; k < speeds.length; k++) {
      const ratios: number[] = []
      for (let i = 25; i < grid.length; i++) {
        const lead = speeds[0][i]
        if (lead > 20 && Math.abs(lead - speeds[0][i - 25]) <= 0.03 * lead) ratios.push(speeds[k][i] / lead)
      }
      if (ratios.length < 50) continue
      const pct = 100 * median(ratios)
      if (worst === null || Math.abs(100 - pct) > Math.abs(100 - worst)) worst = pct
    }
  }
  return worst
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
