/**
 * The rules the app runs, in order: within a severity, findings are listed in this order (what cost the match first).
 * To add a rule, write src/rules/<area>/<name>.ts and add it here (see CONTRIBUTING.md).
 */
import type { Match } from '../match/match.ts'
import type { Parent, Rule } from './rule.ts'
import { runRules as run, type Consolidators, type Report } from './run.ts'
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
import deviceRebooted from './can/device-rebooted.ts'
import stickyFaults from './foresight/sticky-faults.ts'
import firmwareMismatch from './foresight/firmware-mismatch.ts'
import inputDisconnected from './can/input-disconnected.ts'
import busDropout from './can/bus-dropout.ts'
import usbDropout from './can/usb-dropout.ts'
import dsLogTruncated from './comms/ds-log-truncated.ts'
import limitNotApplied from './power/limit-not-applied.ts'
import margin from './power/margin.ts'
import restVoltage from './power/rest-voltage.ts'
import wiringResistance from './power/wiring-resistance.ts'
import followerMismatch from './mech/follower-mismatch.ts'
import stall from './mech/stall.ts'
import slip from './mech/slip.ts'
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
import pdpBreakerMargin from './power/pdp-breaker-margin.ts'
import controllers from './foresight/controllers.ts'
import gyroStillDrift from './foresight/gyro-still-drift.ts'
import zeroSanity from './foresight/zero-sanity.ts'
import commitMatches from './foresight/commit-matches.ts'
import motorTemperature from './foresight/motor-temperature.ts'
import valuesUpdating from './foresight/values-updating.ts'
import cameraSeesTag from './foresight/camera-sees-tag.ts'
import logUsbStick from './foresight/log-usb-stick.ts'
import deviceFault from './can/device-fault.ts'

export const RULES: Rule[] = [
  brownout, batteryCollapse, restartMidMatch, emergencyStop, commsLoss, earlyDisable, noneAtEnable, stuckState, tilt, zeroNotCompleted, deviceDropout, inputDisconnected, busDropout, deviceRebooted, dsLogTruncated,
  limitNotApplied, mainBreakerMargin, pdpBreakerMargin, margin, restVoltage, wiringResistance, pdNotReporting, followerMismatch, slip, stall, impact, overrun,
  visionOutliers, visionStale, visionTimeSync, dirty, identity, gaugeCapacity, passthrough, usbDropout,
]

/**
 * Foresight, the live pit check (src/foresight/): the rules that can judge a robot sitting disabled, worst first.
 * Existing rules judge the disabled stretch since start-up settled (MatchView.beforeEnable); the foresight/* rules
 * only run here. Auto choice and alliance are left out: the chooser resets when the robot is power-cycled on the field.
 */
export const FORESIGHT_RULES: Rule[] = [
  restVoltage, deviceDropout, busDropout, deviceRebooted, stickyFaults, firmwareMismatch, valuesUpdating, controllers, zeroSanity, motorTemperature, dirty, visionStale, visionTimeSync,
  identity, gaugeCapacity, commitMatches, logUsbStick, passthrough, cameraSeesTag, gyroStillDrift,
]

/**
 * Experimental rules (ADR 14): read data no robot log has confirmed yet (today: the .hoot). Never in RULES: they run on
 * their own (`withExperimental`) into the report's experimental tier, so nothing counts them and no summary reads them.
 */
export const EXPERIMENTAL_RULES: Rule[] = [deviceFault]

/**
 * The report with the experimental rules' answers for this match: their findings in `experimental`, their not-checked
 * reasons in `experimentalSkipped`, their crashes with the others. Everything else is the same objects. A log no rule
 * reads (formats.ts `runsNoRules`) is left as it is.
 */
export function withExperimental(match: Match, report: Report): Report {
  if (report.noRules) return report
  const ids = new Set(EXPERIMENTAL_RULES.map((r) => r.id))
  const tier = run(match, EXPERIMENTAL_RULES)
  return {
    ...report,
    crashed: [...report.crashed.filter((c) => !ids.has(c.rule)), ...tier.crashed],
    experimental: tier.findings.filter((f) => f.rule !== 'meta/not-checked'),
    experimentalSkipped: tier.skipped,
  }
}

export type { Report, SkippedRule } from './run.ts'
import { LINKS } from './links.ts'
import { PARENTS } from './parents.ts'
export { LINKS, PARENTS }

/** The consolidators match analysis runs after the rules: in each pass, the links, then the parents. */
export const CONSOLIDATORS: Consolidators = { links: LINKS, parents: PARENTS }

/** Run the rules on a match. Match analysis passes CONSOLIDATORS; Foresight (engine.ts) passes the links only. */
export function runRules(match: Match, rules: Rule[] = RULES, consolidators: Consolidators = {}): Report {
  return run(match, rules, consolidators)
}

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id) ?? FORESIGHT_RULES.find((r) => r.id === id) ?? EXPERIMENTAL_RULES.find((r) => r.id === id)
}

/** The rule or parent behind a finding (for its title, who acts and why it exists). */
export function makerOf(id: string): Rule | Parent | undefined {
  return ruleById(id) ?? PARENTS.find((p) => p.id === id)
}
