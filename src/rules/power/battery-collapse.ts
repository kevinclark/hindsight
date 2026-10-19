/**
 * Did this battery run out of capacity during the match?
 *
 * Checks: the battery's estimated open-circuit voltage (V + R·I) at each 0.5 Ah of charge drawn, against a healthy
 * battery (src/power/fleet-reference.ts). Fires when any point is more than 1.5 V below. Red when the match also
 * browned out, amber otherwise.
 * Why: CalGames 2026 P0's battery matched Q13/Q21 for the first ~3.5 Ah, then collapsed: ~8 V at 6.25 Ah where a
 * healthy battery reads ~10.4 V. It was fully charged (12.66 V) and the wiring was fine (11 mΩ). It was weak.
 */
import { ocvCurve, type PowerGrid } from '../../power/battery-model.ts'
import { FLEET_REFERENCE, fleetVoltageAt } from '../../power/fleet-reference.ts'
import { rule, round, volts } from '../rule.ts'

/** More than this far below a healthy battery counts as a collapsed battery. */
export const MOST_BELOW_HEALTHY = 1.5

/**
 * The point where this battery's estimated open-circuit voltage was furthest below a healthy battery's at the same
 * charge drawn (only where there is a healthy battery to compare with). Used by power/brownout and power/margin too.
 */
export function furthestBelowHealthy(grid: PowerGrid, resistanceOhms: number) {
  const lastReference = FLEET_REFERENCE[FLEET_REFERENCE.length - 1].ah
  const compared = ocvCurve(grid, resistanceOhms, 0.5).filter((p) => p.ah <= lastReference).map((p) => ({ ...p, healthy: fleetVoltageAt(p.ah) }))
  return compared.sort((a, b) => (b.healthy - b.volts) - (a.healthy - a.volts))[0] ?? null
}

export default rule({
  id: 'power/battery-collapse',
  title: 'Battery ran out of capacity',
  severity: 'warning',
  who: ['pit'],
  meaning: 'The battery\'s voltage fell much further than a healthy battery\'s does once part of its charge was used. It ran out of capacity before the match was over.',
  causes: [
    { id: 'weak-battery', cause: 'The battery is weak or worn (it cannot deliver its full charge)', look: 'Power tab: this battery\'s open-circuit curve against the healthy one; a capacity test; the battery\'s history in other matches' },
    { id: 'not-full', cause: 'The battery started the match only partly charged', look: 'the power/rest-voltage finding: voltage before auto; the charger cart' },
    { id: 'wiring', cause: 'High resistance in the battery leads or connections hiding as a weak battery', look: 'Power tab: battery + wiring resistance; tug-test and re-crimp the leads and main breaker lugs' },
  ],
  nextStep: 'Take this battery out of competition use and capacity-test it (a battery analyzer: 10 A down to 11 V). Under 12 Ah twice means practice only.',
  incident: 'CalGames 2026 P0: estimated open-circuit voltage collapsed after ~3.5 Ah (hindsight-research/REVIEW.md items 1–3)',

  check(match) {
    const { report, grid } = match.power()
    if (report.resistanceOhms === null) return match.couldNotCheck('too few current steps to measure resistance')
    const lastReference = FLEET_REFERENCE[FLEET_REFERENCE.length - 1].ah
    if (ocvCurve(grid, report.resistanceOhms, 0.5).some((p) => p.ah > lastReference)) match.checkedOnlyPart(`charge past ${lastReference} Ah: no healthy battery to compare with there`)
    const worst = furthestBelowHealthy(grid, report.resistanceOhms)
    if (!worst || worst.healthy - worst.volts <= MOST_BELOW_HEALTHY) return
    const brownedOut = match.has('brownedOut') && match.signal('brownedOut').turnsOn().length > 0
    // Rank by what the log shows: a battery that started charged, with fine wiring, points at the battery itself.
    const rest = match.autoStart === null ? NaN : match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
    const startedLow = rest < match.profile.power.restVoltageMin
    const wiringHigh = report.resistanceOhms > match.profile.power.healthyResistanceMaxOhms
    const likely = [...(startedLow ? ['not-full'] : []), ...(wiringHigh ? ['wiring'] : []), 'weak-battery']
    const ruledOut: Record<string, string> = {}
    if (rest >= match.profile.power.restVoltageMin) ruledOut['not-full'] = `it rested at ${volts(rest)} before auto`
    if (!wiringHigh) ruledOut.wiring = `resistance was only ${round(report.resistanceOhms * 1000, 1)} mΩ`
    return {
      likely, ruledOut,
      message: `Battery fell ${(worst.healthy - worst.volts).toFixed(1)} V below a healthy battery at ${worst.ah} Ah drawn`,
      at: worst.t,
      severity: brownedOut ? 'error' : 'warning',
      evidence: {
        'charge drawn (Ah)': worst.ah,
        'estimated open-circuit voltage (V)': round(worst.volts),
        'healthy battery at that charge (V)': round(worst.healthy),
        'battery + wiring resistance used (mΩ)': round(report.resistanceOhms * 1000, 1),
        'match also browned out': brownedOut ? 'yes' : 'no',
      },
      measured: [{ label: 'below a healthy battery', value: round(worst.healthy - worst.volts), unit: 'V', threshold: MOST_BELOW_HEALTHY }],
    }
  },
})
