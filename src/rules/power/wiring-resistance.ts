/**
 * Is the battery + wiring resistance too high?
 *
 * Checks: resistance measured from current steps (see resistanceFromSteps in src/power/battery-model.ts) against
 * 20 mΩ. A loose crimp or a tired battery adds resistance, and then every amp costs more voltage.
 * Why: CalGames 2026 measured 11.0–11.4 mΩ in all three matches; Chief Delphi puts a good battery under 20 mΩ.
 * Not yet: "+5 mΩ against this robot's history" needs the history file (phase 2).
 */
import { rule, round } from '../rule.ts'

const MOST_OHMS = 0.020

export default rule({
  id: 'power/wiring-resistance',
  title: 'Battery + wiring resistance',
  severity: 'warning',
  who: ['pit'],
  fix: 'Tug-test and re-crimp the battery leads and main breaker lugs; then load-test the battery. Good is under 20 mΩ.',
  incident: 'Baseline: CalGames 2026 measured 11.0–11.4 mΩ (P0 analysis); threshold from Chief Delphi (hindsight-research/battery-sources.md)',

  check(match) {
    const ohms = match.power().report.resistanceOhms
    if (ohms === null) return match.couldNotCheck('too few current steps over 100 A to measure resistance')
    if (ohms <= MOST_OHMS) return
    return {
      message: `Battery + wiring resistance ${(ohms * 1000).toFixed(1)} mΩ (want under ${MOST_OHMS * 1000} mΩ)`,
      evidence: { 'resistance (mΩ)': round(ohms * 1000, 1), 'most OK (mΩ)': MOST_OHMS * 1000 },
      measured: [{ label: 'battery + wiring resistance', value: round(ohms * 1000, 1), unit: 'mΩ', threshold: MOST_OHMS * 1000 }],
    }
  },
})
