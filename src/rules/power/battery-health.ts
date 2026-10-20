/**
 * What the power model says about a match's battery and wiring, for the power rules that rank causes by it
 * (power/brownout, power/margin, power/battery-collapse). Not a rule itself.
 */
import { ocvCurve, type PowerGrid } from '../../power/battery-model.ts'
import type { PowerReport } from '../../power/power-report.ts'
import { FLEET_REFERENCE, fleetVoltageAt } from '../../power/fleet-reference.ts'
import { round } from '../rule.ts'
import type { MatchView } from '../view.ts'

/** More than this far below a healthy battery counts as a collapsed battery. */
export const MOST_BELOW_HEALTHY = 1.5

/** The highest charge drawn (Ah) that there is a healthy battery to compare with. */
export const LAST_REFERENCE_AH = FLEET_REFERENCE[FLEET_REFERENCE.length - 1].ah

/**
 * The point where this battery's estimated open-circuit voltage was furthest below a healthy battery's at the same
 * charge drawn (only where there is a healthy battery to compare with).
 */
export function furthestBelowHealthy(grid: PowerGrid, resistanceOhms: number) {
  const compared = ocvCurve(grid, resistanceOhms, 0.5)
    .filter((p) => p.ah <= LAST_REFERENCE_AH)
    .map((p) => ({ ...p, healthy: fleetVoltageAt(p.ah), below: fleetVoltageAt(p.ah) - p.volts }))
  return compared.sort((a, b) => b.below - a.below)[0] ?? null
}

/**
 * The battery's health in this match. `power` is match.power() or match.powerIfLogged(): each rule decides whether
 * it needs the motor currents. Anything the log can't tell is null (or false).
 */
export function batteryHealth(match: MatchView, power: { report: PowerReport; grid: PowerGrid } | null) {
  const limits = match.profile.power
  const ohms = power?.report.resistanceOhms ?? null
  const worst = power && ohms !== null ? furthestBelowHealthy(power.grid, ohms) : null
  // The battery at rest in the 2 s before auto (NaN if the robot never enabled).
  const rest = match.autoStart === null ? NaN : match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
  return {
    /** Battery + wiring resistance (Ω), or null when there were too few current steps to measure it. */
    ohms,
    milliohms: ohms === null ? null : round(ohms * 1000, 1),
    wiringHigh: ohms !== null && ohms > limits.healthyResistanceMaxOhms,
    wiringFine: ohms !== null && ohms <= limits.healthyResistanceMaxOhms,
    /** Where the battery was furthest below a healthy one: charge drawn (ah), volts, healthy volts, how far below. */
    worst,
    /** The same point, only when it was far enough below to count as a collapsed battery (else null). */
    collapse: worst !== null && worst.below > MOST_BELOW_HEALTHY ? worst : null,
    rest,
    startedLow: rest < limits.restVoltageMin,
    startedFull: rest >= limits.restVoltageMin,
  }
}
