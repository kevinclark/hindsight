/**
 * battery/identity — do we know which battery was in the robot?
 *
 * Checks: the FRC8033BatteryTracker keys (Battery/Id, Battery/IdSource, BatteryGauge/Valid). Fires when the ID is
 * unknown, or comes from the dashboard because the fuel gauge wasn't valid.
 * Why: CalGames 2026 P0 browned out on a weak battery and nobody could say which one. Per-battery history is how
 * a weak battery gets caught (hindsight-proposal.md, conclusion 3).
 * When it fires: check the gauge is plugged in and has a nickname; if it has no gauge, type the label on the
 * dashboard (BatteryId) after every swap.
 */
import { firstPresent, values, type Match } from '../../match/match.ts'
import { heldAt } from '../../match/series.ts'
import type { Finding, NotChecked, Rule } from '../types.ts'

export const identity: Rule = {
  id: 'battery/identity',
  title: 'Battery not identified',
  fix: 'Plug in the battery\'s fuel gauge (and give it a nickname with PWF\'s tool), or type its label in the BatteryId dashboard field after every swap.',
  incident: 'CalGames 2026 P0: the weak battery could not be identified after the match (hindsight-proposal.md §3); library: kevinclark/8033-battery-tracker',
  needs: () => [],
  run(m: Match): Finding[] | NotChecked {
    const b = m.profile.battery
    const idKey = firstPresent(m, b.id)
    const sourceKey = firstPresent(m, b.idSource)
    if (!idKey || !sourceKey) return { notChecked: 'no FRC8033BatteryTracker keys (Battery/Id) in this log' }
    const at = m.matchStart ?? m.logEnd
    const id = heldAt(values<string>(m, idKey)!, at) ?? ''
    const source = heldAt(values<string>(m, sourceKey)!, at) ?? 'none'
    if (id && (source === 'gauge' || source === 'gauge-cached')) return []
    return [{
      rule: this.id,
      severity: 'warning',
      title: id ? `Battery ${id} identified from the dashboard, not its fuel gauge` : 'Battery ID unknown for this match',
      time: m.matchStart,
      evidence: { 'battery id': id || '(none)', 'id source': source },
    }]
  },
}
