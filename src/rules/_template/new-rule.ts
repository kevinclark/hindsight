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
import { WPILIB_BROWNOUTS } from '../sources.ts'

const LIMIT = 7 // name your thresholds, with the unit in the name if you can

export default rule({
  id: '<area>/<name>',
  title: '<short title>',
  severity: 'warning',
  // 'fault' if something broke or disconnected; 'performance' if it measures a margin, rate or quality (see rule.ts).
  judges: 'performance',
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
  // At least one public page you opened and read (take it from src/rules/sources.ts, or add it there), and what it says.
  sources: [{ ...WPILIB_BROWNOUTS, says: '<e.g. Below 6.3 V (roboRIO 1) the controller switches every motor off.>' }],
  // Each number the rule judges by: 'measured' on logs (say what you measured) or 'judgment' (say whose).
  thresholds: [{ name: 'lowest battery voltage', value: `${LIMIT} V`, basis: 'judgment', how: '<e.g. just above the roboRIO brownout setting>' }],

  check(match) {
    // Guard first: return as soon as there is nothing wrong.
    const battery = match.signal('batteryVoltage')
    const dips = battery.episodes(below(LIMIT), { during: match.enabled })
    if (dips.length === 0) return

    // Name each number once, then use it in the message, the evidence and `measured`.
    const firstDip = dips[0]
    const lowest = round(battery.lowest(match.enabled).value)
    return {
      message: `Battery dipped under ${LIMIT} V, first ${match.whenAt(firstDip.start)}`,
      at: firstDip.start,
      evidence: { 'times under the limit': dips.length, 'lowest (V)': lowest },
      measured: [{ label: 'lowest battery voltage', value: lowest, unit: 'V', threshold: LIMIT }],
      plot: { signals: [battery], unit: 'V' },
      // Optional: when the evidence points at a cause, name it (by id) so it is listed first.
      // likely: ['<short-name>'],
    }
  },
})
