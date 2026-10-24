/**
 * Did this battery run out of capacity during the match?
 *
 * Checks: the battery's estimated open-circuit voltage (V + R·I) at each 0.5 Ah of charge drawn, against a healthy
 * battery (src/power/fleet-reference.ts). Fires when any point is more than 1.5 V below. Red when the match also
 * browned out, amber otherwise.
 * Why: One 2026 match's battery matched two healthy ones for the first ~3.5 Ah, then collapsed: ~8 V at 6.25 Ah where a
 * healthy battery reads ~10.4 V. It was fully charged (12.66 V) and the wiring was fine (11 mΩ). It was weak.
 */
import { ocvCurve } from '../../power/battery-model.ts'
import { rule, round, volts } from '../rule.ts'
import { CD_BATTERY_ACCEPTANCE, CD_BATTERY_CBA_LINE, MK_ES17_12 } from '../sources.ts'
import { batteryHealth, LAST_REFERENCE_AH, MOST_BELOW_HEALTHY, restBeforeAuto } from './battery-health.ts'

export default rule({
  id: 'power/battery-collapse',
  title: 'Battery ran out of capacity',
  severity: 'warning',
  judges: 'performance',
  who: ['pit'],
  meaning: 'The battery\'s voltage fell much further than a healthy battery\'s does once part of its charge was used. It ran out of capacity before the match was over.',
  causes: [
    { id: 'weak-battery', cause: 'The battery is weak or worn (it cannot deliver its full charge)', look: 'Power tab: this battery\'s open-circuit curve against the healthy one; a capacity test; the battery\'s history in other matches' },
    { id: 'not-full', cause: 'The battery started the match only partly charged', look: 'the power/rest-voltage finding: voltage before auto; the charger cart' },
    { id: 'wiring', cause: 'High resistance in the battery leads or connections hiding as a weak battery', look: 'Power tab: battery + wiring resistance; tug-test and re-crimp the leads and main breaker lugs' },
  ],
  nextStep: 'Take this battery out of competition use and capacity-test it (a battery analyzer: 10 A down to 11 V). Under 12 Ah twice means practice only.',
  incident: 'One 2026 match: estimated open-circuit voltage collapsed after ~3.5 Ah (hindsight-research/REVIEW.md items 1–3)',
  sources: [
    { ...MK_ES17_12, says: 'The ES17-12 is rated 18 Ah at the 20-hour rate but 6.3 Ah when drawn at 3C (54 A) down to 9.6 V: capacity shrinks as the draw grows.' },
    { ...CD_BATTERY_ACCEPTANCE, says: 'One poster\'s competition acceptance criteria for a battery: state of health above 80 %, CCA above 240, internal resistance under 12 mΩ.' },
    { ...CD_BATTERY_CBA_LINE, says: 'A quoted poster puts the AM battery-analyzer figure at 12 Ah with a 10.5 V cutoff; the poster thinks the pass line should be higher and would be concerned using a battery that tested under 15 Ah, 14 at the minimum.' },
  ],
  thresholds: [
    { name: 'below a healthy battery', value: '1.5 V', basis: 'judgment', how: 'Chosen. Not measured against the spread of healthy batteries: the healthy curve below is only two batteries.' },
    { name: 'healthy battery curve (open-circuit voltage by charge drawn)', value: '11.94 V at 0.25 Ah to 10.38 V at 6.25 Ah', basis: 'measured', how: 'The lower of the batteries of two 2026 matches that finished without a brownout, estimated as V + R·I in 0.5 Ah bins (R 11.3 and 11.4 mΩ).' },
  ],

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
    const brownedOut = (match.signalIfLogged('brownedOut')?.turnsOn().length ?? 0) > 0
    const rest = restBeforeAuto(match)

    // Rank by what the log shows: a battery that started charged, with fine wiring, points at the battery itself.
    const likely: string[] = []
    if (rest.low) likely.push('not-full')
    if (health.wiringHigh) likely.push('wiring')
    likely.push('weak-battery')
    const ruledOut: Record<string, string> = {}
    if (rest.full) ruledOut['not-full'] = `it rested at ${volts(rest.volts)} before auto`
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
