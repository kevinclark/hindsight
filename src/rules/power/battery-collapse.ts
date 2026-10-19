/**
 * Did this battery run out of capacity during the match?
 *
 * Checks: the battery's estimated open-circuit voltage (V + R·I) at each 0.5 Ah of charge drawn, against a healthy
 * battery (src/power/fleet-reference.ts). Fires when any point is more than 1.5 V below. Red when the match also
 * browned out, amber otherwise.
 * Why: CalGames 2026 P0's battery matched Q13/Q21 for the first ~3.5 Ah, then collapsed: ~8 V at 6.25 Ah where a
 * healthy battery reads ~10.4 V. It was fully charged (12.66 V) and the wiring was fine (11 mΩ). It was weak.
 */
import { ocvCurve } from '../../power/battery-model.ts'
import { FLEET_REFERENCE, fleetVoltageAt } from '../../power/fleet-reference.ts'
import { rule, round } from '../rule.ts'

const MOST_BELOW_HEALTHY = 1.5

export default rule({
  id: 'power/battery-collapse',
  title: 'Battery ran out of capacity',
  severity: 'warning',
  who: ['pit'],
  fix: 'Take this battery out of competition use and capacity-test it (AndyMark CBA, 10 A down to 11 V). Under 12 Ah twice means practice only.',
  incident: 'CalGames 2026 P0: estimated open-circuit voltage collapsed after ~3.5 Ah (hindsight-research/REVIEW.md items 1–3)',

  check(match) {
    const { report, grid } = match.power()
    if (report.resistanceOhms === null) return match.couldNotCheck('too few current steps to measure resistance')
    const curve = ocvCurve(grid, report.resistanceOhms, 0.5)
    const lastReference = FLEET_REFERENCE[FLEET_REFERENCE.length - 1].ah
    if (curve.some((p) => p.ah > lastReference)) match.checkedOnlyPart(`charge past ${lastReference} Ah: no healthy battery to compare with there`)
    const compared = curve.filter((p) => p.ah <= lastReference).map((p) => ({ ...p, healthy: fleetVoltageAt(p.ah) }))
    const worst = compared.sort((a, b) => (b.healthy - b.volts) - (a.healthy - a.volts))[0]
    if (!worst || worst.healthy - worst.volts <= MOST_BELOW_HEALTHY) return
    const brownedOut = match.has('brownedOut') && match.signal('brownedOut').turnsOn().length > 0
    return {
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
    }
  },
})
