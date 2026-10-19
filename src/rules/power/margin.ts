/**
 * How close did the battery voltage come to the brownout setting?
 *
 * Checks: the lowest battery voltage while enabled, against the brownout setting + 1.0 V, and the seconds spent
 * under 7 V in auto and in teleop.
 * Why: CalGames 2026 Q13 (6.28 V) and Q21 (6.15 V) came within 0.3 V of the 6.0 V setting a day before P0 browned out.
 */
import { below, rule, round, volts } from '../rule.ts'

const MARGIN_VOLTS = 1.0

export default rule({
  id: 'power/margin',
  title: 'Voltage margin to brownout',
  severity: 'warning',
  who: ['software', 'pit'],
  fix: 'Keep at least 1 V of margin: enable supply limits on the high-draw groups, use only batteries that pass a load test, and shed load below ~7 V in code.',
  incident: 'CalGames 2026 Q13/Q21: minimum 6.28 V and 6.15 V against a 6.0 V setting (2026-10-17-calgames-q13-log-analysis.md §3)',

  check(match) {
    const battery = match.signal('batteryVoltage')
    const setting = match.signal('brownoutVoltage').last()
    const low = battery.lowest(match.enabled)
    if (Number.isNaN(low.value)) return
    const margin = low.value - setting
    if (margin >= MARGIN_VOLTS) return
    const secondsUnder7 = (phase: typeof match.auto) => battery.episodes(below(7), { during: phase }).reduce((s, e) => s + e.seconds, 0)
    return {
      message: `Battery fell to ${volts(low.value)} at ${match.when(low.at)}, ${volts(Math.abs(margin))} ${margin >= 0 ? 'above' : 'below'} the ${setting} V brownout setting`,
      at: low.at,
      evidence: {
        'lowest voltage while enabled (V)': round(low.value),
        'brownout setting (V)': setting,
        'margin (V)': round(margin),
        'seconds under 7 V in auto': round(secondsUnder7(match.auto), 1),
        'seconds under 7 V in teleop': round(secondsUnder7(match.teleop), 1),
      },
      plot: [battery], plotUnit: 'V', plotFrom: low.at - 10, plotTo: low.at + 10,
      plotLine: { value: setting, label: 'brownout setting' }, plotMarks: [low.at],
    }
  },
})
