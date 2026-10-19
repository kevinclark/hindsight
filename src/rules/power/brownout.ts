/**
 * Did the roboRIO brown out?
 *
 * Checks: every time /SystemStats/BrownedOut turns on. Below the brownout setting the roboRIO switches every
 * motor off until the voltage recovers: the robot goes limp.
 * Why: CalGames 2026 P0 browned out 53 times in the last 18 s; nine shots in a row failed.
 */
import { rule, round } from '../rule.ts'

export default rule({
  id: 'power/brownout',
  title: 'roboRIO brownout',
  severity: 'error',
  who: ['software', 'pit'],
  fix: 'Find the loads on at each sag (Power tab). Usual causes: a weak or uncharged battery, a loose battery or main-breaker crimp, current limits left off. Load-test the battery used.',
  incident: 'CalGames 2026 P0: brownouts from 532.8 s, battery collapse after ~3.5 Ah (8033/robot/2026-10-17-calgames-q13-log-analysis.md, P0 section)',

  check(match) {
    const onsets = match.signal('brownedOut').turnsOn()
    if (onsets.length === 0) return
    const first = onsets[0]
    const last = onsets[onsets.length - 1]
    const battery = match.signal('batteryVoltage')
    // The setting is context; a log without it still gets its brownouts reported.
    const setting = match.has('brownoutVoltage') ? match.signal('brownoutVoltage').last() : NaN
    return {
      message: `Browned out ${onsets.length} time${onsets.length === 1 ? '' : 's'}, first at ${match.when(first)}`,
      at: first,
      evidence: {
        'brownout onsets': onsets.length,
        'first (s)': round(first),
        'last (s)': round(last),
        'lowest voltage around the first (V)': round(battery.lowest(match.between(first - 1, first + 1)).value),
        'brownout setting (V)': Number.isNaN(setting) ? 'not logged' : setting,
      },
      plot: [battery], plotUnit: 'V', plotFrom: first - 8, plotTo: Math.min(first + 12, last + 2),
      plotLine: Number.isNaN(setting) ? undefined : { value: setting, label: 'brownout setting' }, plotMarks: onsets,
    }
  },
})
