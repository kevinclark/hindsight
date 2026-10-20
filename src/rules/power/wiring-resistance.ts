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
  meaning: 'Every amp the robot draws costs extra voltage in the battery and its wiring. At this resistance the voltage drops more than it should, which brings a brownout closer.',
  causes: [
    { id: 'crimp', cause: 'A poor crimp or loose lug on a battery lead or the main breaker', look: 'tug-test and look at both battery leads and the main breaker lugs; warm spots after a hard run' },
    { id: 'connector', cause: 'A worn or loose battery connector (the Anderson plug on the battery or the robot side)', look: 'the connector halves: bent or burnt contacts, a plug that comes apart easily' },
    { id: 'battery', cause: 'A tired battery with high internal resistance', look: 'try another battery and see if the resistance changes; a load test of this one' },
    { id: 'thin-wire', cause: 'Wire that is too thin or too long between the battery and the main breaker', look: 'the battery leads and the main power path: gauge and length' },
  ],
  nextStep: 'Tug-test and re-crimp the battery leads and main breaker lugs; then load-test the battery. Good is under 20 mΩ.',
  incident: 'Baseline: CalGames 2026 measured 11.0–11.4 mΩ (P0 analysis); threshold from Chief Delphi (hindsight-research/battery-sources.md)',

  check(match) {
    const ohms = match.power().report.resistanceOhms
    if (ohms === null) return match.couldNotCheck('too few current steps over 100 A to measure resistance')
    if (ohms <= MOST_OHMS) return

    const milliohms = ohms * 1000
    const mostMilliohms = MOST_OHMS * 1000
    return {
      message: `Battery + wiring resistance ${milliohms.toFixed(1)} mΩ (want under ${mostMilliohms} mΩ)`,
      evidence: { 'resistance (mΩ)': round(milliohms, 1), 'most OK (mΩ)': mostMilliohms },
      measured: [{ label: 'battery + wiring resistance', value: round(milliohms, 1), unit: 'mΩ', threshold: mostMilliohms }],
    }
  },
})
