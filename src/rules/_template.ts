/**
 * <area>/<name> — <one line: what question this rule answers>
 *
 * Checks: <exactly what it measures, and the threshold>
 * Why: <the incident: which match, what happened, a link to the analysis>
 * When it fires: <what a student should do or check>
 *
 * Copy this file to src/rules/<area>/<name>.ts, fill it in, and add it to RULES in src/rules/index.ts.
 * Ask the profile for log keys (m.profile.signals...); never type a log key into a rule.
 */
import { num, type Match } from '../match/match.ts'
import { when } from './helpers.ts'
import type { Finding, Rule } from './types.ts'

const LIMIT = 0 // <the threshold, with its unit in the name if you can>

export const templateRule: Rule = {
  id: '<area>/<name>',
  title: '<short title>',
  fix: '<what to do when it fires>',
  incident: '<match, date, link>',
  needs: (m: Match) => [m.profile.signals.batteryVoltage],
  run(m: Match): Finding[] {
    const s = num(m, m.profile.signals.batteryVoltage)!
    const out: Finding[] = []
    for (let i = 0; i < s.t.length; i++) {
      if (s.v[i] >= LIMIT) continue
      out.push({
        rule: this.id,
        severity: 'warning',
        title: `<what happened> at ${when(m, s.t[i])}`,
        time: s.t[i],
        evidence: { 'value': s.v[i], 'limit': LIMIT },
      })
      break
    }
    return out
  },
}
