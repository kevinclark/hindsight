/**
 * <One question this rule answers, e.g. "Did the battery dip under 7 V while the robot was enabled?">
 *
 * Checks: <exactly what it measures, and the threshold>
 * Why: <the failure it catches, and where it was seen or documented>
 *
 * Copy this file to src/rules/<area>/<name>.ts, fill it in, and add it to RULES in src/rules/index.ts.
 * Everything a rule can ask is in src/rules/view.ts; the helpers (below, above, volts, ...) are in src/rules/rule.ts.
 */
import { below, rule, round } from '../rule.ts'

const LIMIT = 7 // name your thresholds, with the unit in the name if you can

export default rule({
  id: '<area>/<name>',
  title: '<short title>',
  severity: 'warning',
  who: ['pit'],
  // What it probably means when it fires, in a sentence or two.
  meaning: '<e.g. The battery or its wiring could not hold voltage under load; the robot was close to browning out.>',
  // What could cause it, most likely first. Each says what to look for, and where: a tab, a part, a file.
  causes: [
    { id: '<short-name>', cause: '<e.g. A tired battery>', look: '<e.g. Power tab: battery + wiring resistance above 20 mΩ>' },
    { id: '<another>', cause: '<e.g. A loose main lead>', look: '<e.g. tug-test the battery connector and the main breaker lugs>' },
  ],
  // The one thing to do next.
  nextStep: '<e.g. Swap the battery and run the same routine; if it still dips, check the wiring.>',
  incident: '<what it catches, where it was seen>',

  check(match) {
    const battery = match.signal('batteryVoltage')
    const dips = battery.episodes(below(LIMIT), { during: match.enabled })
    if (dips.length === 0) return
    return {
      message: `Battery dipped under ${LIMIT} V, first at ${match.when(dips[0].start)}`,
      at: dips[0].start,
      evidence: { 'times under the limit': dips.length, 'lowest (V)': round(battery.lowest(match.enabled).value) },
      plot: [battery], plotUnit: 'V',
      // Optional: when the evidence points at a cause, name it (by id) so it is listed first.
      // likely: ['<short-name>'],
    }
  },
})
