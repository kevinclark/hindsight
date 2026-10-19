/**
 * power/margin — how close did the battery voltage come to the brownout setting?
 *
 * Checks: the lowest bus voltage while enabled, against the brownout setting + 1.0 V, and the seconds spent under
 * 7 V in auto and in teleop.
 * Why: CalGames 2026 Q13 (6.28 V) and Q21 (6.15 V) came within 0.3 V of the 6.0 V setting a day before P0 browned out.
 * When it fires: the next weaker battery or one more motor browns the robot out. See the Power tab for the loads.
 */
import { num, type Match } from '../../match/match.ts'
import { valueAt } from '../../match/series.ts'
import { intervalsWhere, lowIn, when } from '../helpers.ts'
import { totalDuration } from '../../match/series.ts'
import type { Finding, Rule } from '../types.ts'

export const margin: Rule = {
  id: 'power/margin',
  title: 'Voltage margin to brownout',
  audience: ['software', 'pit'],
  fix: 'Keep at least 1 V of margin: enable supply limits on the high-draw groups, use only batteries that pass a load test, and shed load below ~7 V in code.',
  incident: 'CalGames 2026 Q13/Q21: minimum 6.28 V and 6.15 V against a 6.0 V setting (2026-10-17-calgames-q13-log-analysis.md §3)',
  needs: (m: Match) => [m.profile.signals.batteryVoltage, m.profile.signals.brownoutVoltage],
  run(m: Match): Finding[] {
    const s = m.profile.signals
    const volts = num(m, s.batteryVoltage)!
    const setting = valueAt(num(m, s.brownoutVoltage)!, Infinity)
    let low = { value: Infinity, t: NaN }
    for (const iv of m.enabled) {
      const l = lowIn(volts, iv.start, iv.end)
      if (l.value < low.value) low = l
    }
    if (!Number.isFinite(low.value)) return []
    const marginV = low.value - setting
    if (marginV >= m.profile.power.marginVolts) return []
    const under7 = (phase: typeof m.auto) => totalDuration(intervalsWhere(volts, (v) => v < 7, phase, m.logEnd))
    return [{
      rule: this.id,
      severity: 'warning',
      title: `Battery fell to ${low.value.toFixed(2)} V at ${when(m, low.t)}, ${Math.abs(marginV).toFixed(2)} V ${marginV >= 0 ? 'above' : 'below'} the ${setting} V brownout setting`,
      time: low.t,
      evidence: {
        'lowest voltage while enabled (V)': +low.value.toFixed(2),
        'brownout setting (V)': setting,
        'margin (V)': +marginV.toFixed(2),
        'seconds under 7 V in auto': +under7(m.auto).toFixed(1),
        'seconds under 7 V in teleop': +under7(m.teleop).toFixed(1),
      },
      plot: {
        from: low.t - 10, to: low.t + 10, unit: 'V',
        lines: [{ label: 'Battery voltage', key: s.batteryVoltage }],
        threshold: { value: setting, label: 'brownout setting' },
        markers: [{ t: low.t, label: 'lowest' }],
      },
    }]
  },
}
