/**
 * The list of rules the app runs, and the runner. To add a rule, write src/rules/<area>/<name>.ts and add it here
 * (see CONTRIBUTING.md).
 */
import { has, type Match } from '../match/match.ts'
import type { Finding, Rule, Severity } from './types.ts'
import { notCheckedFinding, type SkippedRule } from './meta/not-checked.ts'
import { brownout } from './power/brownout.ts'
import { margin } from './power/margin.ts'
import { batteryCollapse } from './power/battery-collapse.ts'
import { wiringResistance } from './power/wiring-resistance.ts'
import { restVoltage } from './power/rest-voltage.ts'
import { limitNotApplied } from './power/limit-not-applied.ts'
import { deviceDropout } from './can/device-dropout.ts'
import { commsLoss } from './comms/loss.ts'
import { dsLogTruncated } from './comms/ds-log-truncated.ts'
import { earlyDisable } from './auto/early-disable.ts'
import { zeroNotCompleted } from './mech/zero-not-completed.ts'
import { followerMismatch } from './mech/follower-mismatch.ts'
import { tilt } from './collision/tilt.ts'
import { impact } from './collision/impact.ts'
import { overrun } from './loop/overrun.ts'
import { visionOutliers } from './vision/outliers.ts'
import { visionStale } from './vision/stale.ts'
import { visionTimeSync } from './vision/time-sync.ts'
import { dirty } from './build/dirty.ts'
import { passthrough } from './alerts/passthrough.ts'
import { identity } from './battery/identity.ts'
import { gaugeCapacity } from './battery/gauge-capacity.ts'

export const RULES: Rule[] = [
  brownout, margin, batteryCollapse, wiringResistance, restVoltage, limitNotApplied,
  deviceDropout, commsLoss, dsLogTruncated, earlyDisable, zeroNotCompleted, followerMismatch,
  tilt, impact, overrun, visionOutliers, visionStale, visionTimeSync, dirty, passthrough,
  identity, gaugeCapacity,
]

export interface Report {
  findings: Finding[]
  skipped: SkippedRule[]
  /** Rules that threw: a bug in the rule, shown so it isn't silent. */
  crashed: SkippedRule[]
  ruleMs: Record<string, number>
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function runRules(match: Match, rules: Rule[] = RULES): Report {
  const findings: Finding[] = []
  const skipped: SkippedRule[] = []
  const crashed: SkippedRule[] = []
  const ruleMs: Record<string, number> = {}
  for (const rule of rules) {
    const started = performance.now()
    const missing = rule.needs(match).filter((key) => !has(match, key))
    if (missing.length) {
      skipped.push({ rule: rule.id, reason: `missing ${missing.join(', ')}` })
      continue
    }
    try {
      const result = rule.run(match)
      if ('notChecked' in result) skipped.push({ rule: rule.id, reason: result.notChecked })
      else findings.push(...result)
    } catch (error) {
      crashed.push({ rule: rule.id, reason: String(error) })
    }
    ruleMs[rule.id] = performance.now() - started
  }
  const meta = notCheckedFinding(skipped)
  if (meta) findings.push(meta)
  // Worst first: severity, then the rule's place in RULES (most important first), then time.
  const place = (f: Finding) => { const i = rules.findIndex((r) => r.id === f.rule); return i < 0 ? rules.length : i }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || place(a) - place(b) || (a.time ?? Infinity) - (b.time ?? Infinity))
  return { findings, skipped, crashed, ruleMs }
}

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id)
}
