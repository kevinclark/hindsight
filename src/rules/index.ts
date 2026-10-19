/**
 * The rules the app runs, in order: within a severity, findings are listed in this order (what cost the match first).
 * To add a rule, write src/rules/<area>/<name>.ts and add it here (see CONTRIBUTING.md).
 */
import type { Match } from '../match/match.ts'
import type { Rule } from './rule.ts'
import { runRules as run, type Report } from './run.ts'
import brownout from './power/brownout.ts'
import batteryCollapse from './power/battery-collapse.ts'
import commsLoss from './comms/loss.ts'
import earlyDisable from './auto/early-disable.ts'
import tilt from './collision/tilt.ts'
import zeroNotCompleted from './mech/zero-not-completed.ts'
import deviceDropout from './can/device-dropout.ts'
import dsLogTruncated from './comms/ds-log-truncated.ts'
import limitNotApplied from './power/limit-not-applied.ts'
import margin from './power/margin.ts'
import restVoltage from './power/rest-voltage.ts'
import wiringResistance from './power/wiring-resistance.ts'
import followerMismatch from './mech/follower-mismatch.ts'
import impact from './collision/impact.ts'
import overrun from './loop/overrun.ts'
import visionOutliers from './vision/outliers.ts'
import visionStale from './vision/stale.ts'
import visionTimeSync from './vision/time-sync.ts'
import dirty from './build/dirty.ts'
import identity from './battery/identity.ts'
import gaugeCapacity from './battery/gauge-capacity.ts'
import passthrough from './alerts/passthrough.ts'
import pdNotReporting from './power/pd-not-reporting.ts'
import mainBreakerMargin from './power/main-breaker-margin.ts'

export const RULES: Rule[] = [
  brownout, batteryCollapse, commsLoss, earlyDisable, tilt, zeroNotCompleted, deviceDropout, dsLogTruncated,
  limitNotApplied, mainBreakerMargin, margin, restVoltage, wiringResistance, pdNotReporting, followerMismatch, impact, overrun,
  visionOutliers, visionStale, visionTimeSync, dirty, identity, gaugeCapacity, passthrough,
]

export type { Report, SkippedRule } from './run.ts'

export function runRules(match: Match, rules: Rule[] = RULES): Report {
  return run(match, rules)
}

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id)
}
