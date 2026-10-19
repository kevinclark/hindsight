/**
 * <One question this rule answers, e.g. "Was the battery charged when the match started?">
 *
 * Checks: <exactly what it measures, and the threshold>
 * Why: <the incident: which match, what happened>
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
  fix: '<what to do when it fires>',
  incident: '<match, date, link to the write-up>',

  check(match) {
    const battery = match.signal('batteryVoltage')
    const dips = battery.episodes(below(LIMIT), { during: match.enabled })
    if (dips.length === 0) return
    return {
      message: `Battery dipped under ${LIMIT} V, first at ${match.when(dips[0].start)}`,
      at: dips[0].start,
      evidence: { 'times under the limit': dips.length, 'lowest (V)': round(battery.lowest(match.enabled).value) },
      plot: [battery], plotUnit: 'V',
    }
  },
})


