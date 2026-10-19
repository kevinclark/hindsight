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

// Order matters: within a severity, findings are listed in this order. Things that cost the match come first.
export const RULES: Rule[] = [
  brownout, batteryCollapse, commsLoss, earlyDisable, tilt, zeroNotCompleted, deviceDropout, dsLogTruncated,
  limitNotApplied, margin, restVoltage, wiringResistance, followerMismatch, impact, overrun,
  visionOutliers, visionStale, visionTimeSync, dirty, identity, gaugeCapacity, passthrough,
]

export interface Report {
  findings: Finding[]
  skipped: SkippedRule[]
  /** Rules that threw: a bug in the rule, shown so it isn't silent. */
  crashed: SkippedRule[]
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

export function runRules(match: Match, rules: Rule[] = RULES): Report {
  const findings: Finding[] = []
  const skipped: SkippedRule[] = []
  const crashed: SkippedRule[] = []
  for (const rule of rules) {
    try {
      const missing = rule.needs(match).filter((key) => !has(match, key))
      if (missing.length) {
        skipped.push({ rule: rule.id, reason: `missing ${missing.join(', ')}` })
        continue
      }
      const result = rule.run(match)
      if ('notChecked' in result) skipped.push({ rule: rule.id, reason: result.notChecked })
      else if ('missing' in result) {
        findings.push(...result.findings)
        if (result.missing.length) skipped.push({ rule: rule.id, reason: `partly checked; missing ${result.missing.join(', ')}` })
      } else findings.push(...result)
    } catch (error) {
      crashed.push({ rule: rule.id, reason: String(error) })
    }
  }
  const meta = notCheckedFinding(skipped)
  if (meta) findings.push(meta)
  // Worst first: severity, then the rule's place in RULES (most important first), then time.
  const place = (f: Finding) => { const i = rules.findIndex((r) => r.id === f.rule); return i < 0 ? rules.length : i }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || place(a) - place(b) || (a.time ?? Infinity) - (b.time ?? Infinity))
  return { findings, skipped, crashed }
}

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id)
}
