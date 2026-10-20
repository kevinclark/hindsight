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
import { rule, round, volts } from '../rule.ts'
import { batteryHealth, LAST_REFERENCE_AH, MOST_BELOW_HEALTHY } from './battery-health.ts'

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
    const power = match.power()
    const ohms = power.report.resistanceOhms
    if (ohms === null) return match.couldNotCheck('too few current steps to measure resistance')
    if (ocvCurve(power.grid, ohms, 0.5).some((p) => p.ah > LAST_REFERENCE_AH)) {
      match.checkedOnlyPart(`charge past ${LAST_REFERENCE_AH} Ah: no healthy battery to compare with there`)
    }
    const health = batteryHealth(match, power)
    const worst = health.collapse
    if (!worst) return
    const brownedOut = match.has('brownedOut') && match.signal('brownedOut').turnsOn().length > 0

    // Rank by what the log shows: a battery that started charged, with fine wiring, points at the battery itself.
    const likely: string[] = []
    if (health.startedLow) likely.push('not-full')
    if (health.wiringHigh) likely.push('wiring')
    likely.push('weak-battery')
    const ruledOut: Record<string, string> = {}
    if (health.startedFull) ruledOut['not-full'] = `it rested at ${volts(health.rest)} before auto`
    if (!health.wiringHigh) ruledOut.wiring = `resistance was only ${health.milliohms} mΩ`

    return {
      message: `Battery fell ${worst.below.toFixed(1)} V below a healthy battery at ${worst.ah} Ah drawn`,
      at: worst.t,
      severity: brownedOut ? 'error' : 'warning',
      likely, ruledOut,
      evidence: {
        'charge drawn (Ah)': worst.ah,
        'estimated open-circuit voltage (V)': round(worst.volts),
        'healthy battery at that charge (V)': round(worst.healthy),
        'battery + wiring resistance used (mΩ)': round(ohms * 1000, 1),
        'match also browned out': brownedOut ? 'yes' : 'no',
      },
      measured: [{ label: 'below a healthy battery', value: round(worst.below), unit: 'V', threshold: MOST_BELOW_HEALTHY }],
    }
  },
})
