/**
 * A limits-wizard session: the sweep the student is running, step by step, with what each checked log showed.
 * Saved as limits-session.json (the page can't save files itself: the student downloads it and drops it back in).
 *
 * The tool never changes robot code or motor settings. Each step tells the student what to set and where; the
 * student does it, runs the mechanism, and drops the log in to be checked.
 */

import type { Match } from '../match/match.ts'
import type { MotorGroup, RobotProfile } from '../profiles/types.ts'
import { median } from '../match/series.ts'
import { confirmed, findSpinUps, recommend, runsComparable, settingTookEffect, shotRecoveries, summarize, type Comparable, type SpinUp, type SweepPoint, type TookEffect } from './sweep.ts'
import { robotBudget, type Budget } from './budget.ts'

export const SESSION_SCHEMA = 'hindsight.limits-session/1'
export const SESSION_FILE_NAME = 'limits-session.json'

export interface SweepStep {
  /** The supply limit for this step, A per motor; null = no limit (the baseline). */
  limitA: number | null
  /** Battery label the student typed (until the battery tracker logs it). */
  batteryId: string
  /** The log that was checked for this step, and what it showed. */
  logFile: string | null
  runs: SpinUp[]
  took: TookEffect | null
}

export interface LimitsSession {
  schema: string
  group: string
  createdAt: string
  /** The knee: the lowest limit whose spin-up is at most this much slower than with no limit (default 20 %). */
  slowerByPct: number
  steps: SweepStep[]
  /** The student's choice for SupplyCurrentLowerLimit / SupplyCurrentLowerTime in the final code change. */
  lowerLimitA: number | null
  lowerSeconds: number | null
}

/** The default sweep: no limit, then 60, 50, 40, 30 A. */
export function newSession(profile: RobotProfile, group: string, sweep: (number | null)[] = [null, 60, 50, 40, 30]): LimitsSession {
  if (!profile.motorGroups.some((g) => g.name === group)) throw new Error(`no motor group "${group}" in the robot profile`)
  return {
    schema: SESSION_SCHEMA, group, createdAt: new Date().toISOString(), slowerByPct: 20,
    steps: sweep.map((limitA) => ({ limitA, batteryId: '', logFile: null, runs: [], took: null })),
    lowerLimitA: null, lowerSeconds: null,
  }
}

export function groupOf(profile: RobotProfile, session: LimitsSession): MotorGroup {
  return profile.motorGroups.find((g) => g.name === session.group)!
}

/** Check the log dropped in for one step: find the runs, and whether the limit took effect. Returns a new session. */
export function checkStep(session: LimitsSession, index: number, match: Match, batteryId: string): LimitsSession {
  const group = groupOf(match.profile, session)
  // The tracker's logged ID wins; until the robot code logs it, the label the student typed is used.
  const runs = findSpinUps(match, group).map((r) => ({ ...r, batteryId: r.batteryId ?? (batteryId.trim() || null) }))
  const step = session.steps[index]
  const took = step.limitA === null || runs.length === 0 ? null : settingTookEffect(runs, step.limitA)
  const steps = session.steps.map((s, i) => (i === index ? { ...s, batteryId, logFile: match.fileName, runs, took } : s))
  return { ...session, steps }
}

/** Are the runs so far comparable (same battery, start within 0.3 V, same setpoint)? Across the whole sweep. */
export function comparability(session: LimitsSession): Comparable {
  const runs = session.steps.flatMap((s) => s.runs.map((r) => ({ batteryId: r.batteryId, startVolts: r.startVolts, target: r.target, label: `${s.limitA ?? 'no limit'}` })))
  return runsComparable(runs)
}

export interface SweepResult {
  points: SweepPoint[]
  /** Steps left out because their limit didn't take, or the runs can't show it took (re-run or check them). */
  leftOut: (number | null)[]
  recommended: { limitA: number; baseline: number } | null
  /** Shot recovery in the loaded match logs (median, count), the match version of spin-up time. */
  recovery: { median: number; shots: number; matches: number }
  /** The robot budget from the loaded match logs, with the recommended limit applied. */
  budget: Budget | null
  /** The line(s) to change, in words the student types. */
  codeChange: string
}

export function sweepResult(session: LimitsSession, profile: RobotProfile, matches: Match[]): SweepResult {
  // A step whose limit didn't take (or can't be shown to have taken) may have measured something else: it is plotted
  // but left out of the recommendation until it is re-run or confirmed.
  const usable = session.steps.filter((s) => s.runs.length > 0 && confirmed(s.took))
  const points = usable.map((s) => summarize(s.limitA, s.runs.filter((r) => Number.isFinite(r.timeToSetpoint))))
  const recommended = recommend(points, session.slowerByPct / 100)
  const group = groupOf(profile, session)
  const recoveries = matches.flatMap((m) => shotRecoveries(m, group))
  const budget = recommended && matches[0] ? robotBudget(matches[0], { [group.name]: recommended.limitA }) : null
  const where = group.limits.supplyLines ?? group.limits.where
  const lower = Number.isFinite(session.lowerLimitA) && Number.isFinite(session.lowerSeconds)
    ? `, SupplyCurrentLowerLimit = ${session.lowerLimitA} and SupplyCurrentLowerTime = ${session.lowerSeconds}`
    : ' (and choose SupplyCurrentLowerLimit / SupplyCurrentLowerTime: if you leave them out, Phoenix drops the cap to 40 A after 1 s at the limit)'
  const codeChange = recommended
    ? `${where}: SupplyCurrentLimit = ${recommended.limitA} and SupplyCurrentLimitEnable = true${lower}`
    : 'No recommendation yet: run and check the no-limit step and at least one limit.'
  const leftOut = session.steps.filter((s) => s.runs.length > 0 && !confirmed(s.took)).map((s) => s.limitA)
  return { points, leftOut, recommended, recovery: { median: median(recoveries), shots: recoveries.length, matches: matches.length }, budget, codeChange }
}

export function serializeSession(session: LimitsSession): string {
  return JSON.stringify(session, null, 1)
}

export function parseSession(text: string): LimitsSession {
  const s = JSON.parse(text)
  if (s.schema !== SESSION_SCHEMA) throw new Error(`not a ${SESSION_FILE_NAME} (schema ${s.schema ?? 'missing'})`)
  return s as LimitsSession
}
