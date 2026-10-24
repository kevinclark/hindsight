/**
 * Show every Alert the robot code raised, so none is silent.
 *
 * Checks: each alert text the robot code raised. During the match it keeps the programmers' type (error → red,
 * warning → amber, info → grey), counted inside the match only; before or after the match it is grey. In Foresight
 * (the live pit check) "the match" is the disabled stretch since start-up settled.
 * Camera time-sync alerts are left to vision/time-sync.
 * Why: one 2026 match raised "Flywheel Follower Disconnected" 7 times and nobody saw it until the log review.
 */
import { isTimeSyncAlert } from '../vision/time-sync.ts'
import { rule, round } from '../rule.ts'

export default rule({
  id: 'alerts/passthrough',
  title: 'Robot code alerts',
  severity: 'info',
  who: ['software'],
  meaning: 'The robot code raised an alert: a message its programmers chose to show on the dashboard. The type (error, warning, info) is how serious they thought it was.',
  causes: [
    { id: 'condition', cause: 'The condition the code watches for really happened (a device disconnected, a sensor out of range)', look: 'the alert text names the thing; check that part. Search the robot code for the exact text to see what raises it' },
    { id: 'hardware', cause: 'A loose connector, cable or power wire on the part the alert names', look: 'the part named in the alert: its connector, cable and power; the Match tab around the time it came on' },
    { id: 'bad-check', cause: 'The check in the code is too touchy or wrong (it fires when nothing is broken)', look: 'the code file that creates the alert: what makes it turn on, and for how long' },
  ],
  nextStep: 'Search the robot code for the alert text to find what raises it, then check the part it names.',
  incident: 'One 2026 match: "Flywheel Follower Disconnected" ×7, unseen during the match (hindsight-research/design-detail.md §5a)',
  forEach: 'alert',

  check(alert, match) {
    if (isTimeSyncAlert(alert)) return
    const during = alert.onsetsInMatch.length
    const firstTimes = alert.onsetsInMatch.slice(0, 6).map((t) => match.when(t)).join('; ')
    const window = match.windowWords

    const message = during > 0
      ? `Alert "${alert.text}" ${during}× ${window}`
      : `Alert "${alert.text}" only before or after the match (${alert.onsetsOutsideMatch}×)`
    return {
      message,
      at: alert.onsetsInMatch[0] ?? null,
      severity: during > 0 ? alert.kind : 'info',
      evidence: {
        group: alert.group,
        [`times ${window}`]: during,
        [`first times ${window}`]: firstTimes || '—',
        [`seconds on ${window}`]: round(alert.secondsInMatch, 1),
        'times before or after the match': alert.onsetsOutsideMatch,
      },
    }
  },
})
