/**
 * Was the battery charged when the match started?
 *
 * Checks: the median battery voltage over the 2 s before auto, against 12.5 V.
 * Why: CalGames 2026 Q21 started at 12.44 V and sagged deeper than Q13 (12.65 V) on the same robot.
 */
import { rule, volts, round } from '../rule.ts'

const LOWEST_REST_VOLTAGE = 12.5

export default rule({
  id: 'power/rest-voltage',
  title: 'Battery not fully charged',
  severity: 'warning',
  who: ['pit'],
  fix: 'Put a battery reading 12.5 V or more at rest on the robot. A charged battery that rests lower needs a load test.',
  incident: 'CalGames 2026 Q21: 12.44 V before auto (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 2)',

  check(match) {
    if (match.autoStart === null) return
    const rest = match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
    if (rest >= LOWEST_REST_VOLTAGE) return
    return {
      message: `Battery rested at ${volts(rest)} before auto (want ${LOWEST_REST_VOLTAGE} V or more)`,
      at: match.autoStart,
      evidence: { 'rest voltage, 2 s before auto (V)': round(rest), 'lowest OK (V)': LOWEST_REST_VOLTAGE },
      measured: [{ label: 'rest voltage before auto', value: round(rest), unit: 'V', threshold: LOWEST_REST_VOLTAGE }],
      plot: ['batteryVoltage'], plotUnit: 'V', plotFrom: match.autoStart - 10, plotTo: match.autoStart + 5,
      plotLine: { value: LOWEST_REST_VOLTAGE, label: `${LOWEST_REST_VOLTAGE} V` },
    }
  },
})
