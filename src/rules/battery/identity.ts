/**
 * Do we know which battery was in the robot?
 *
 * Checks: the FRC8033BatteryTracker keys (Battery/Id, Battery/IdSource) at the start of the match. Fires when the ID
 * is unknown, or came from the dashboard because the fuel gauge wasn't reporting.
 * Why: CalGames 2026 P0 browned out on a weak battery and nobody could say which one.
 */
import { rule } from '../rule.ts'

export default rule({
  id: 'battery/identity',
  title: 'Battery not identified',
  severity: 'warning',
  who: ['pit'],
  fix: 'Plug in the battery\'s fuel gauge (and give it a nickname with PWF\'s tool), or type its label in the BatteryId dashboard field after every swap.',
  incident: 'CalGames 2026 P0: the weak battery could not be identified after the match (hindsight-proposal.md §3); library: kevinclark/8033-battery-tracker',

  check(match) {
    const b = match.profile.battery
    const at = match.autoStart ?? Infinity
    const id = match.text(match.firstOf(b.id)).at(at)
    const source = match.text(match.firstOf(b.idSource)).at(at) || 'none'
    if (id && (source === 'gauge' || source === 'gauge-cached')) return
    return {
      message: id ? `Battery ${id} identified from the dashboard, not its fuel gauge` : 'Battery ID unknown for this match',
      at: match.autoStart,
      evidence: { 'battery id': id || '(none)', 'id source': source },
    }
  },
})
