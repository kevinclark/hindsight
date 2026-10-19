/**
 * power/brownout — did the roboRIO brown out?
 *
 * Checks: every time /SystemStats/BrownedOut turns true. When the bus voltage falls below the brownout setting,
 * the roboRIO disables every motor output until the voltage recovers. The robot goes limp.
 * Why: CalGames 2026 P0 browned out 20+ times in the last 18 s; nine shots in a row failed.
 * When it fires: look at the Power tab. Which loads were on at each sag? Was the battery weak (power/battery-collapse)?
 */
import { num, type Match } from '../../match/match.ts'
import { valueAt } from '../../match/series.ts'
import { lowIn, risingEdges, when } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

export const brownout: Rule = {
  id: 'power/brownout',
  title: 'roboRIO brownout',
  audience: ['software', 'pit'],
  fix: 'Find the loads on at each sag (Power tab). Usual causes: a weak or uncharged battery, a loose battery or main-breaker crimp, current limits left off. Load-test the battery used.',
  incident: 'CalGames 2026 P0: brownouts from 532.8 s, battery collapse after ~3.5 Ah (8033/robot/2026-10-17-calgames-q13-log-analysis.md, P0 section)',
  needs: (m: Match) => [m.profile.signals.brownedOut, m.profile.signals.batteryVoltage],
  run(m: Match): Finding[] {
    const s = m.profile.signals
    const flag = num(m, s.brownedOut)!
    const volts = num(m, s.batteryVoltage)!
    const onsets = risingEdges(flag)
    if (onsets.length === 0) return []
    const first = onsets[0]
    const settingSeries = num(m, s.brownoutVoltage)
    const setting = settingSeries ? valueAt(settingSeries, first) : NaN
    const low = lowIn(volts, first - 1, first + 1)
    return [{
      rule: this.id,
      severity: 'error',
      title: `Browned out ${onsets.length} time${onsets.length === 1 ? '' : 's'}, first at ${when(m, first)}`,
      time: first,
      evidence: {
        'brownout onsets': onsets.length,
        'first onset (s)': +first.toFixed(2),
        'last onset (s)': +onsets[onsets.length - 1].toFixed(2),
        'lowest voltage near first onset (V)': +low.value.toFixed(2),
        'brownout setting (V)': Number.isFinite(setting) ? setting : 'not logged',
      },
      plot: {
        from: first - 8, to: Math.min(first + 12, onsets[onsets.length - 1] + 2), unit: 'V',
        lines: [{ label: 'Battery voltage', key: s.batteryVoltage }],
        threshold: Number.isFinite(setting) ? { value: setting, label: 'brownout setting' } : undefined,
        markers: onsets.slice(0, 30).map((t) => ({ t, label: '' })),
      },
    }]
  },
}
