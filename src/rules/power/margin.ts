/**
 * How close did the battery voltage come to the brownout setting?
 *
 * Checks: the lowest battery voltage while enabled, against the brownout setting + 1.0 V, and the seconds spent
 * under 7 V in auto and in teleop.
 * Why: Two 2026 matches (6.28 V and 6.15 V) came within 0.3 V of the 6.0 V setting a day before a third browned out.
 */
import { below, rule, round, totalSeconds, volts } from '../rule.ts'
import { WPILIB_BROWNOUTS } from '../sources.ts'
import { batteryHealth, restBeforeAuto } from './battery-health.ts'

const MARGIN_VOLTS = 1.0

export default rule({
  id: 'power/margin',
  title: 'Voltage margin to brownout',
  severity: 'warning',
  judges: 'performance',
  who: ['software', 'pit'],
  meaning: 'The battery voltage came close to the brownout level (or below it). A little more load or a slightly weaker battery would have turned the robot off.',
  causes: [
    { id: 'load', cause: 'Too much current at once (big motors starting together, current limits off)', look: 'Power tab: total current and the biggest motor group at the lowest point; the Limits tab for groups with no limit' },
    { id: 'not-full', cause: 'The battery started the match only partly charged', look: 'the power/rest-voltage finding: voltage before auto; the charger cart' },
    { id: 'weak-battery', cause: 'A weak or worn battery that sags a lot under load', look: 'the power/battery-collapse finding; a load test of this battery' },
    { id: 'wiring', cause: 'High resistance in the battery leads, connectors or main breaker', look: 'Power tab: battery + wiring resistance (over 20 mΩ is high); tug-test the battery leads and main breaker lugs' },
  ],
  nextStep: 'Keep at least 1 V of margin: turn on supply limits on the big motor groups, use only batteries that pass a load test, and shed load in code when the voltage nears 7 V.',
  incident: 'Two 2026 matches: minimum 6.28 V and 6.15 V against a 6.0 V setting',
  sources: [
    { ...WPILIB_BROWNOUTS, says: 'The roboRIO 1 browns out below 6.3 V; a roboRIO 2 defaults to 6.75 V and RobotController.setBrownoutVoltage() changes it.' },
  ],
  thresholds: [
    { name: 'margin over the brownout setting', value: '1.0 V', basis: 'judgment', how: 'Chosen. Two 2026 matches (6.28 V and 6.15 V) came within 0.3 V of a 6.0 V setting a day before a third browned out.' },
    { name: 'seconds counted under', value: '7 V', basis: 'judgment', how: 'Chosen, just above the 6.75 V roboRIO 2 default brownout level.' },
  ],

  check(match) {
    const battery = match.signal('batteryVoltage')
    const setting = match.signal('brownoutVoltage').last()
    const low = battery.lowest(match.enabled)
    if (Number.isNaN(low.value)) {
      return match.couldNotCheck(match.enabled.length === 0 ? 'the robot was never enabled' : 'no battery voltage logged while enabled')
    }
    const margin = low.value - setting
    if (margin >= MARGIN_VOLTS) return
    const rest = restBeforeAuto(match)
    const health = batteryHealth(match, match.powerIfLogged())
    const secondsUnder7 = (phase: typeof match.auto) => totalSeconds(battery.episodes(below(7), { during: phase }))

    // Rank by what the log shows: a poor start, a collapsed battery or high resistance first, otherwise the load.
    const likely: string[] = []
    if (rest.low) likely.push('not-full')
    if (health.collapse) likely.push('weak-battery')
    if (health.wiringHigh) likely.push('wiring')
    likely.push('load')
    const ruledOut: Record<string, string> = {}
    if (rest.full) ruledOut['not-full'] = `it rested at ${volts(rest.volts)} before auto`
    if (health.wiringFine) ruledOut.wiring = `resistance was only ${health.milliohms} mΩ`

    return {
      likely, ruledOut,
      message: `Battery fell to ${volts(low.value)} ${match.whenAt(low.at)}, ${volts(Math.abs(margin))} ${margin >= 0 ? 'above' : 'below'} the ${setting} V brownout setting`,
      at: low.at,
      evidence: {
        'lowest voltage while enabled (V)': round(low.value),
        'brownout setting (V)': setting,
        'rested before auto (V)': Number.isFinite(rest.volts) ? round(rest.volts) : 'not logged',
        'battery + wiring resistance (mΩ)': health.milliohms ?? 'not measured',
        'margin (V)': round(margin),
        'seconds under 7 V in auto': round(secondsUnder7(match.auto), 1),
        'seconds under 7 V in teleop': round(secondsUnder7(match.teleop), 1),
      },
      measured: [{ label: 'lowest voltage while enabled', value: round(low.value), unit: 'V', threshold: setting + MARGIN_VOLTS }],
      plot: { signals: [battery], unit: 'V', from: low.at - 10, to: low.at + 10, line: { value: setting, label: 'brownout setting' }, marks: [low.at] },
    }
  },
})
