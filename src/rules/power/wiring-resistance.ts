/**
 * power/wiring-resistance — is the battery + wiring resistance too high?
 *
 * Checks: resistance from current steps (1 s windows with ≥ 100 A swing, median of V-vs-I slopes) against 20 mΩ.
 * Why: a loose crimp or a tired battery adds resistance, and every amp then costs more voltage. CalGames 2026
 * measured 11.0–11.4 mΩ in all three matches; Chief Delphi puts a good battery under 20 mΩ.
 * When it fires: check the main breaker, battery lugs and Anderson crimps; then load-test the battery.
 * Not yet checked: "+5 mΩ against this robot's history" needs history.jsonl (phase 2).
 */
import type { Match } from '../../match/match.ts'
import { buildPowerGrid, resistanceFromSteps } from '../../power/battery-model.ts'
import type { Finding, NotChecked, Rule } from '../types.ts'

export const wiringResistance: Rule = {
  id: 'power/wiring-resistance',
  title: 'Battery + wiring resistance',
  audience: ['pit'],
  fix: 'Tug-test and re-crimp the battery leads and main breaker lugs; then load-test the battery. Good is under 20 mΩ.',
  incident: 'Baseline: CalGames 2026 measured 11.0–11.4 mΩ (P0 analysis); threshold from Chief Delphi (hindsight-research/battery-sources.md)',
  needs: (m: Match) => [m.profile.signals.batteryVoltage, m.profile.signals.enabled],
  run(m: Match): Finding[] | NotChecked {
    const grid = buildPowerGrid(m)
    if (!grid) return { notChecked: 'no motor supply currents in this log' }
    const r = resistanceFromSteps(grid)
    if (!r) return { notChecked: 'too few current steps to estimate resistance' }
    const limit = m.profile.power.healthyResistanceMaxOhms
    if (r.ohms <= limit) return []
    return [{
      rule: this.id,
      severity: 'warning',
      title: `Battery + wiring resistance ${(r.ohms * 1000).toFixed(1)} mΩ (want under ${limit * 1000} mΩ)`,
      time: null,
      evidence: { 'resistance (mΩ)': +(r.ohms * 1000).toFixed(1), 'windows used': r.steps, 'limit (mΩ)': limit * 1000 },
    }]
  },
}
