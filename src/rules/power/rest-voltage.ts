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
  meaning: 'The battery started the match partly discharged, so it sags sooner and deeper under load, closer to a brownout.',
  causes: [
    { id: 'not-charged', cause: 'The battery wasn\'t charged, or came off the charger early', look: 'the battery cart and charger: was this battery on it, and did the charger say full?' },
    { id: 'worn', cause: 'A worn battery that no longer holds a full charge', look: 'Power tab: battery + wiring resistance; a load test (battery beak) in the pit' },
    { id: 'drain', cause: 'The robot sat powered on for a long time before the match', look: 'how long the robot was on in the queue (the log starts when the robot code starts)' },
  ],
  nextStep: 'Put a battery reading 12.5 V or more at rest on the robot. If a charged battery rests lower, load-test it.',
  incident: 'CalGames 2026 Q21: 12.44 V before auto (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 2)',

  check(match) {
    if (match.autoStart === null) return
    const rest = match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
    if (!Number.isFinite(rest)) return match.couldNotCheck('no battery voltage logged in the 2 s before auto (the log started too late)')
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
