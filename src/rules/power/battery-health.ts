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
 * This battery's estimated open-circuit voltage against a healthy battery's at the same charge drawn, from one curve:
 * `worst`, the point furthest below (only where there is a healthy battery to compare with; null with no point), and
 * `pastCurve`, whether the match drew more charge than the healthy curve covers (the rest went unchecked).
 */
export function compareWithHealthy(grid: PowerGrid, resistanceOhms: number) {
  const curve = ocvCurve(grid, resistanceOhms, 0.5)
  const compared = curve
    .filter((p) => p.ah <= LAST_REFERENCE_AH)
    .map((p) => ({ ...p, healthy: fleetVoltageAt(p.ah), below: fleetVoltageAt(p.ah) - p.volts }))
  return { worst: compared.sort((a, b) => b.below - a.below)[0] ?? null, pastCurve: curve.some((p) => p.ah > LAST_REFERENCE_AH) }
}

/**
 * What the power model says about the battery and its wiring. `power` is match.power() or match.powerIfLogged():
 * each rule decides whether it needs the motor currents. With no measured resistance, every field is null or false
 * (so wiringHigh and wiringFine are both false: not known).
 */
export function batteryHealth(match: MatchView, power: { report: PowerReport; grid: PowerGrid } | null) {
  const ohms = power?.report.resistanceOhms ?? null
  const worst = power && ohms !== null ? compareWithHealthy(power.grid, ohms).worst : null
  const most = match.profile.power.healthyResistanceMaxOhms
  return {
    /** Battery + wiring resistance (mΩ), or null when there were too few current steps to measure it. */
    milliohms: ohms === null ? null : round(ohms * 1000, 1),
    wiringHigh: ohms !== null && ohms > most,
    wiringFine: ohms !== null && ohms <= most,
    /** Where the battery was furthest below a healthy one, when far enough to count as collapsed (else null). */
    collapse: worst !== null && worst.below > MOST_BELOW_HEALTHY ? worst : null,
  }
}

/** The battery at rest in the 2 s before auto (volts NaN if the robot never enabled; then both flags are false). */
export function restBeforeAuto(match: MatchView) {
  const volts = match.autoStart === null ? NaN : match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
  const lowest = match.profile.power.restVoltageMin
  return { volts, low: volts < lowest, full: volts >= lowest }
}
