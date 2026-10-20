/**
 * Was the battery charged when the match started?
 *
 * Checks: the median battery voltage over the 2 s before auto, against 12.5 V. In Foresight (the live pit check,
 * robot not enabled yet) the last 2 s of the disabled stretch instead.
 * Why: CalGames 2026 Q21 started at 12.44 V and sagged deeper than Q13 (12.65 V) on the same robot.
 */
import { rule, volts, round } from '../rule.ts'

const LOWEST_REST_VOLTAGE = 12.5
const LINE = { value: LOWEST_REST_VOLTAGE, label: `${LOWEST_REST_VOLTAGE} V` }

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
    // Before auto in a match log; in Foresight, now (the end of the disabled stretch).
    const at = match.autoStart ?? match.beforeEnable.at(-1)?.end ?? null
    if (at === null) return
    const inMatchLog = match.autoStart !== null
    const when = inMatchLog ? 'before auto' : 'at rest, last 2 s'
    const rest = match.signal('batteryVoltage').median(match.before(at, 2))
    if (!Number.isFinite(rest)) {
      return match.couldNotCheck(`no battery voltage logged in the 2 s ${inMatchLog ? 'before auto (the log started too late)' : 'up to now'}`)
    }
    if (rest >= LOWEST_REST_VOLTAGE) return

    return {
      message: `Battery rested at ${volts(rest)} ${when} (want ${LOWEST_REST_VOLTAGE} V or more)`,
      at,
      evidence: {
        [`rest voltage, 2 s ${inMatchLog ? 'before auto' : 'up to now'} (V)`]: round(rest),
        'lowest OK (V)': LOWEST_REST_VOLTAGE,
      },
      measured: [{ label: `rest voltage ${inMatchLog ? 'before auto' : 'before enable'}`,
        value: round(rest), unit: 'V', threshold: LOWEST_REST_VOLTAGE }],
      plot: { signals: ['batteryVoltage'], unit: 'V', from: at - 10, to: at + 5, line: LINE },
    }
  },
})
