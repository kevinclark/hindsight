/**
 * Is the robot accepting vision poses far from where odometry says it is?
 *
 * Checks: each camera's accepted vision poses during the match against the odometry pose at the same moment.
 * Fires when more than 5 % are over 0.5 m away, out of at least 20 poses; with fewer, the camera is listed as not checked.
 * Why: CalGames 2026: 5–15 % of accepted poses were over 0.5 m off (up to 8.7 m), and P0 had 4 odometry jumps.
 * Threshold: assumed from three logs; every log so far fires it.
 */
import { maxOf, percentile } from '../../match/series.ts'
import { pct, rule, round } from '../rule.ts'
import { TIME_SYNC_ALERTS } from './time-sync.ts'

const MIN_POSES = 20 // fewer accepted poses than this can't give a rate worth acting on

export default rule({
  id: 'vision/outliers',
  title: 'Vision poses far from odometry',
  severity: 'warning',
  who: ['software'],
  meaning: 'The camera\'s position estimates often disagreed with odometry by half a meter or more, and the robot accepted them. The robot\'s idea of where it is can jump.',
  causes: [
    { id: 'no-filter', cause: 'The code accepts poor poses (a single tag, a far tag, an ambiguous match)', look: 'the code file where vision poses are added to the pose estimator: is there a limit on distance or ambiguity?' },
    { id: 'camera-pose', cause: 'The camera\'s position on the robot in the code is wrong, or the camera shifted on its mount', look: 'the camera-to-robot transform in the code against a tape measure; is the camera mount tight?' },
    { id: 'time-sync', cause: 'The camera clock is not synced, so poses are stamped at the wrong moment', look: 'the vision/time-sync finding; the PhotonVision dashboard' },
    { id: 'odometry', cause: 'Odometry is the one that drifted (wheel slip, a bad gyro)', look: 'does the other camera agree with the vision poses? Wheel slip in the Match tab' },
  ],
  nextStep: 'Reject vision poses more than ~0.5 m from odometry, or weight them by ambiguity and tag distance; check camera mounts and calibration.',
  incident: 'CalGames 2026: 5–15 % of accepted vision poses over 0.5 m from odometry (P0 analysis, "Other issues")',
  forEach: 'camera',

  check(camera, match) {
    const odometry = match.pose('odometryPose')
    const vision = camera.acceptedPose()
    const distances: number[] = []
    vision.series.v.forEach((pose, i) => {
      const t = vision.series.t[i]
      const odo = odometry.at(t)
      if (match.inMatch(t) && odo) distances.push(Math.hypot(pose.x - odo.x, pose.y - odo.y))
    })
    const far = distances.filter((d) => d > 0.5).length
    if (distances.length < MIN_POSES) return match.couldNotCheck(`only ${distances.length} accepted pose${distances.length === 1 ? '' : 's'} in the match (needs ${MIN_POSES} for a rate)`)
    if (far / distances.length <= 0.05) return
    // Alerts about unsynced camera clocks (vision/time-sync) point at the clock first.
    const clockAlerts = match.alerts().some((a) => TIME_SYNC_ALERTS.some((pattern) => pattern.test(a.text)) && a.onsetsInMatch.length > 0)
    return {
      // A time-sync alert during the match rules nothing in (it fires on most logs), but its absence rules it out.
      ruledOut: clockAlerts ? undefined : { 'time-sync': 'no time-sync alert during the match' },
      message: `${camera.name}: ${pct(far / distances.length)} of accepted vision poses were more than 0.5 m from odometry`,
      measured: [{ label: 'accepted poses > 0.5 m from odometry', value: round((100 * far) / distances.length, 1), unit: '%', threshold: 5 }],
      evidence: { 'accepted poses in the match': distances.length, 'over 0.5 m': far, 'p90 distance (m)': round(percentile(distances, 90)), 'farthest (m)': round(maxOf(distances)) },
    }
  },
})
