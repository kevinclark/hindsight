/**
 * The rules the app runs, in order: within a severity, findings are listed in this order (what cost the match first).
 * To add a rule, write src/rules/<area>/<name>.ts and add it here (see CONTRIBUTING.md).
 */
import type { Match } from '../match/match.ts'
import type { Link, Rule } from './rule.ts'
import { runRules as run, type Report } from './run.ts'
import brownout from './power/brownout.ts'
import batteryCollapse from './power/battery-collapse.ts'
import commsLoss from './comms/loss.ts'
import restartMidMatch from './loop/restart-mid-match.ts'
import emergencyStop from './comms/emergency-stop.ts'
import earlyDisable from './auto/early-disable.ts'
import noneAtEnable from './auto/none-at-enable.ts'
import tilt from './collision/tilt.ts'
import zeroNotCompleted from './mech/zero-not-completed.ts'
import stuckState from './mech/stuck-state.ts'
import deviceDropout from './can/device-dropout.ts'
import busDropout from './can/bus-dropout.ts'
import dsLogTruncated from './comms/ds-log-truncated.ts'
import limitNotApplied from './power/limit-not-applied.ts'
import margin from './power/margin.ts'
import restVoltage from './power/rest-voltage.ts'
import wiringResistance from './power/wiring-resistance.ts'
import followerMismatch from './mech/follower-mismatch.ts'
import stall from './mech/stall.ts'
import slip from './mech/slip.ts'
import stoppedWhileEnabled from './loop/stopped-while-enabled.ts'
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
import controllers from './foresight/controllers.ts'
import gyroStillDrift from './foresight/gyro-still-drift.ts'
import zeroSanity from './foresight/zero-sanity.ts'
import commitMatches from './foresight/commit-matches.ts'
import motorTemperature from './foresight/motor-temperature.ts'
import valuesUpdating from './foresight/values-updating.ts'
import cameraSeesTag from './foresight/camera-sees-tag.ts'
import logUsbStick from './foresight/log-usb-stick.ts'

export const RULES: Rule[] = [
  brownout, batteryCollapse, restartMidMatch, stoppedWhileEnabled, emergencyStop, commsLoss, earlyDisable, noneAtEnable, stuckState, tilt, zeroNotCompleted, deviceDropout, busDropout, dsLogTruncated,
  limitNotApplied, mainBreakerMargin, margin, restVoltage, wiringResistance, pdNotReporting, followerMismatch, slip, stall, impact, overrun,
  visionOutliers, visionStale, visionTimeSync, dirty, identity, gaugeCapacity, passthrough,
]

/**
 * Foresight, the live pit check (src/foresight/): the rules that can judge a robot sitting disabled, worst first.
 * Existing rules judge the disabled stretch since start-up settled (MatchView.beforeEnable); the foresight/* rules
 * only run here. Auto choice and alliance are left out: the chooser resets when the robot is power-cycled on the field.
 */
export const FORESIGHT_RULES: Rule[] = [
  restVoltage, deviceDropout, busDropout, valuesUpdating, controllers, zeroSanity, motorTemperature, dirty, visionStale, visionTimeSync,
  identity, gaugeCapacity, commitMatches, logUsbStick, passthrough, cameraSeesTag, gyroStillDrift,
]

export type { Report, SkippedRule } from './run.ts'
export { LINKS } from './links.ts'

/** Run the rules on a match. Match analysis (analyze.ts) also passes LINKS; Foresight passes none. */
export function runRules(match: Match, rules: Rule[] = RULES, links: Link[] = []): Report {
  return run(match, rules, links)
}

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id) ?? FORESIGHT_RULES.find((r) => r.id === id)
}
