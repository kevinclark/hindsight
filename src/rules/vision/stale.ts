/**
 * Is each camera delivering fresh results, and did any drop out during the match?
 *
 * Checks: the share of the match each camera's Stale flag was on (fires above 15 %), and the camera's Connected
 * flag going false during the match.
 * Why: CalGames 2026: Back_Right was stale 18–23 % of the match against 5–8 % for Back_Left, and in Q21 it dropped
 * out for 6 s while its network connection stayed up (the coprocessor pipeline stalled).
 * Threshold: assumed from three logs.
 */
import { lengthOf } from '../view.ts'
import { isFalse, isTrue, pct, rule, round } from '../rule.ts'

export default rule({
  id: 'vision/stale',
  title: 'Camera stale or dropped out',
  severity: 'warning',
  who: ['software', 'pit'],
  fix: 'Check the coprocessor (CPU, temperature), the camera pipeline settings, and the camera\'s cable and power.',
  incident: 'CalGames 2026: Back_Right stale ~3× as often as Back_Left; dropped 6 s in Q21 (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 4)',
  forEach: 'camera',

  check(camera, match) {
    const staleSeconds = camera.stale().episodes(isTrue, { during: match.wholeMatch }).reduce((s, e) => s + e.seconds, 0)
    const staleShare = staleSeconds / lengthOf(match.wholeMatch)
    const drops = camera.connected().episodes(isFalse, { during: match.wholeMatch })
    if (staleShare <= 0.15 && drops.length === 0) return
    return {
      message: drops.length
        ? `${camera.name} dropped out ${drops.length} time${drops.length === 1 ? '' : 's'} during the match (first at ${drops[0].start.toFixed(1)} s for ${drops[0].seconds.toFixed(1)} s)`
        : `${camera.name} was stale ${pct(staleShare)} of the match`,
      at: drops[0]?.start,
      evidence: { 'stale share of the match (%)': round(100 * staleShare, 1), 'dropouts during the match': drops.length, 'seconds disconnected': round(drops.reduce((s, d) => s + d.seconds, 0), 1) },
    }
  },
})
