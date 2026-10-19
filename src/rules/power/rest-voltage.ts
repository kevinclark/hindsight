/**
 * power/rest-voltage — was the battery charged when the match started?
 *
 * Checks: the median bus voltage over the 2 s before auto enable, against 12.5 V.
 * Why: CalGames 2026 Q21 started at 12.44 V and sagged deeper than Q13 (12.65 V) on the same robot.
 * When it fires: the battery wasn't fully charged (or is weak). Check the charger log and the battery's label.
 */
import { num, type Match } from '../../match/match.ts'
import { median } from '../../match/series.ts'
import type { Finding, Rule } from '../types.ts'

export const restVoltage: Rule = {
  id: 'power/rest-voltage',
  title: 'Battery rest voltage before auto',
  audience: ['pit'],
  fix: 'Put a battery reading ≥ 12.5 V at rest on the robot. A charged battery that rests lower needs a load test.',
  incident: 'CalGames 2026 Q21: 12.44 V before auto (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 2)',
  needs: (m: Match) => [m.profile.signals.batteryVoltage],
  run(m: Match): Finding[] {
    if (m.matchStart === null) return []
    const start = m.matchStart
    const volts = num(m, m.profile.signals.batteryVoltage)!
    const before: number[] = []
    for (let i = 0; i < volts.t.length; i++) if (volts.t[i] >= start - 2 && volts.t[i] < start) before.push(volts.v[i])
    if (before.length === 0) return []
    const rest = median(before)
    const min = m.profile.power.restVoltageMin
    if (rest >= min) return []
    return [{
      rule: this.id,
      severity: 'warning',
      title: `Battery rested at ${rest.toFixed(2)} V before auto (want ≥ ${min} V)`,
      time: start,
      evidence: { 'rest voltage, 2 s before auto (V)': +rest.toFixed(2), 'minimum (V)': min },
      plot: {
        from: start - 10, to: start + 5, unit: 'V',
        lines: [{ label: 'Battery voltage', key: m.profile.signals.batteryVoltage }],
        threshold: { value: min, label: `${min} V` },
        markers: [{ t: start, label: 'auto enable' }],
      },
    }]
  },
}
