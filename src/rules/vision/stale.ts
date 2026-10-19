/**
 * vision/stale — is each camera delivering fresh results, and did any drop out during the match?
 *
 * Checks: the share of match time each camera's Stale flag was true (fires above 15 %), and the camera's
 * Connected flag going false during the match.
 * Why: CalGames 2026: Back_Right was stale 18–23 % of the match against 5–8 % for Back_Left, and in Q21 it dropped
 * off for 6 s while its NetworkTables client stayed connected (the coprocessor pipeline stalled).
 * Threshold: assumed from three logs.
 * When it fires: check that camera's coprocessor load and pipeline settings (resolution, exposure), its USB/Ethernet
 * cable and power.
 */
import { has, num, type Match } from '../../match/match.ts'
import { totalDuration } from '../../match/series.ts'
import { intervalsWhere, withMissing } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

const STALE_SHARE = 0.15

export const visionStale: Rule = {
  id: 'vision/stale',
  title: 'Camera stale or dropped out',
  audience: ['software', 'pit'],
  fix: 'Check the coprocessor (CPU, temperature), the camera pipeline settings, and the camera\'s cable and power.',
  incident: 'CalGames 2026: Back_Right stale ~3× as often as Back_Left; dropped 6 s in Q21 (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 4)',
  needs: () => [],
  run(m: Match) {
    if (m.matchStart === null || m.matchEnd === null) return []
    const match = [{ start: m.matchStart, end: m.matchEnd }]
    const length = m.matchEnd - m.matchStart
    const out: Finding[] = []
    const missing: string[] = []
    for (const cam of m.profile.cameras) {
      if (!has(m, cam.stale)) { missing.push(cam.stale); continue }
      const staleShare = totalDuration(intervalsWhere(num(m, cam.stale)!, (v) => v > 0.5, match, m.logEnd)) / length
      const drops = has(m, cam.connected) ? intervalsWhere(num(m, cam.connected)!, (v) => v < 0.5, match, m.logEnd) : []
      if (staleShare <= STALE_SHARE && drops.length === 0) continue
      out.push({
        rule: this.id,
        severity: 'warning',
        title: drops.length
          ? `${cam.name} dropped out ${drops.length} time${drops.length === 1 ? '' : 's'} during the match (first at ${drops[0].start.toFixed(1)} s for ${(drops[0].end - drops[0].start).toFixed(1)} s)`
          : `${cam.name} was stale ${(100 * staleShare).toFixed(0)} % of the match`,
        time: drops[0]?.start ?? null,
        evidence: {
          'stale share of match (%)': +(100 * staleShare).toFixed(1),
          'dropouts during match': drops.length,
          'seconds disconnected': +totalDuration(drops).toFixed(1),
        },
      })
    }
    return withMissing(out, missing, m.profile.cameras.length)
  },
}
