/**
 * How close did the battery voltage come to the brownout setting?
 *
 * Checks: the lowest battery voltage while enabled, against the brownout setting + 1.0 V, and the seconds spent
 * under 7 V in auto and in teleop.
 * Why: CalGames 2026 Q13 (6.28 V) and Q21 (6.15 V) came within 0.3 V of the 6.0 V setting a day before P0 browned out.
 */
import { furthestBelowHealthy, MOST_BELOW_HEALTHY } from './battery-collapse.ts'
import { below, rule, round, volts } from '../rule.ts'

const MARGIN_VOLTS = 1.0

export default rule({
  id: 'power/margin',
  title: 'Voltage margin to brownout',
  severity: 'warning',
  who: ['software', 'pit'],
  meaning: 'The battery voltage came close to the brownout level (or below it). A little more load or a slightly weaker battery would have turned the robot off.',
  causes: [
    { id: 'load', cause: 'Too much current at once (big motors starting together, current limits off)', look: 'Power tab: total current and the biggest motor group at the lowest point; the Limits tab for groups with no limit' },
    { id: 'not-full', cause: 'The battery started the match only partly charged', look: 'the power/rest-voltage finding: voltage before auto; the charger cart' },
    { id: 'weak-battery', cause: 'A weak or worn battery that sags a lot under load', look: 'the power/battery-collapse finding; a load test of this battery' },
    { id: 'wiring', cause: 'High resistance in the battery leads, connectors or main breaker', look: 'Power tab: battery + wiring resistance (over 20 mΩ is high); tug-test the battery leads and main breaker lugs' },
  ],
  nextStep: 'Keep at least 1 V of margin: turn on supply limits on the big motor groups, use only batteries that pass a load test, and shed load in code when the voltage nears 7 V.',
  incident: 'CalGames 2026 Q13/Q21: minimum 6.28 V and 6.15 V against a 6.0 V setting (2026-10-17-calgames-q13-log-analysis.md §3)',

  check(match) {
    const battery = match.signal('batteryVoltage')
    const setting = match.signal('brownoutVoltage').last()
    const low = battery.lowest(match.enabled)
    if (Number.isNaN(low.value)) return
    const margin = low.value - setting
    if (margin >= MARGIN_VOLTS) return
    // Rank by what the log shows: a poor start or high resistance first, otherwise the load.
    const rest = match.autoStart === null ? NaN : battery.median(match.before(match.autoStart, 2))
    const power = match.powerIfLogged()
    const ohms = power?.report.resistanceOhms ?? null
    // A battery far below a healthy one at the same charge (power/battery-collapse): a weak battery, not the load.
    const collapse = power && ohms !== null ? furthestBelowHealthy(power.grid, ohms) : null
    const collapsed = collapse !== null && collapse.healthy - collapse.volts > MOST_BELOW_HEALTHY
    const startedLow = rest < match.profile.power.restVoltageMin
    const wiringHigh = ohms !== null && ohms > match.profile.power.healthyResistanceMaxOhms
    const likely = [...(startedLow ? ['not-full'] : []), ...(collapsed ? ['weak-battery'] : []), ...(wiringHigh ? ['wiring'] : []), 'load']
    const ruledOut: Record<string, string> = {}
    if (rest >= match.profile.power.restVoltageMin) ruledOut['not-full'] = `it rested at ${volts(rest)} before auto`
    if (ohms !== null && !wiringHigh) ruledOut.wiring = `resistance was only ${round(ohms * 1000, 1)} mΩ`
    const secondsUnder7 = (phase: typeof match.auto) => battery.episodes(below(7), { during: phase }).reduce((s, e) => s + e.seconds, 0)
    return {
      likely, ruledOut,
      message: `Battery fell to ${volts(low.value)} at ${match.when(low.at)}, ${volts(Math.abs(margin))} ${margin >= 0 ? 'above' : 'below'} the ${setting} V brownout setting`,
      at: low.at,
      evidence: {
        'lowest voltage while enabled (V)': round(low.value),
        'brownout setting (V)': setting,
        'rested before auto (V)': Number.isFinite(rest) ? round(rest) : 'not logged',
        'battery + wiring resistance (mΩ)': ohms === null ? 'not measured' : round(ohms * 1000, 1),
        'margin (V)': round(margin),
        'seconds under 7 V in auto': round(secondsUnder7(match.auto), 1),
        'seconds under 7 V in teleop': round(secondsUnder7(match.teleop), 1),
      },
      measured: [{ label: 'lowest voltage while enabled', value: round(low.value), unit: 'V', threshold: setting + MARGIN_VOLTS }],
      plot: [battery], plotUnit: 'V', plotFrom: low.at - 10, plotTo: low.at + 10,
      plotLine: { value: setting, label: 'brownout setting' }, plotMarks: [low.at],
    }
  },
})
