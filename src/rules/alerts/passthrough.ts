/**
 * Show every Alert the robot code raised, so none is silent.
 *
 * Checks: each alert text the robot code raised. During the match it keeps the programmers' type (error → red,
 * warning → amber, info → grey), counted inside the match only; before or after the match it is grey.
 * Camera time-sync alerts are left to vision/time-sync.
 * Why: CalGames 2026 P0 raised "Flywheel Follower Disconnected" 7 times and nobody saw it until the log review.
 */
import { TIME_SYNC_ALERTS } from '../vision/time-sync.ts'
import { rule, round } from '../rule.ts'

export default rule({
  id: 'alerts/passthrough',
  title: 'Robot code alerts',
  severity: 'info',
  who: ['software'],
  fix: 'Read the alert text; ask whoever wrote that alert what it means and what to check.',
  incident: 'CalGames 2026 P0: "Flywheel Follower Disconnected" ×7, unseen during the match (hindsight-research/design-detail.md §5a)',
  forEach: 'alert',

  check(alert) {
    if (TIME_SYNC_ALERTS.some((pattern) => pattern.test(alert.text))) return
    const during = alert.onsetsInMatch.length
    return {
      message: during ? `Alert "${alert.text}" ${during}× during the match` : `Alert "${alert.text}" only before or after the match (${alert.onsetsOutsideMatch}×)`,
      at: alert.onsetsInMatch[0] ?? null,
      severity: during ? alert.kind : 'info',
      evidence: {
        group: alert.group,
        'times during the match': during,
        'onsets (s)': alert.onsetsInMatch.slice(0, 12).map((t) => t.toFixed(1)).join(', ') || '—',
        'seconds on during the match': round(alert.secondsInMatch, 1),
        'times before or after the match': alert.onsetsOutsideMatch,
      },
    }
  },
})
