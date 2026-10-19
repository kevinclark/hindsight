/**
 * Is the robot accepting vision poses far from where odometry says it is?
 *
 * Checks: each camera's accepted vision poses during the match against the odometry pose at the same moment.
 * Fires when more than 5 % are over 0.5 m away, out of at least 20 poses (2 poses can't give a rate worth acting on).
 * Why: CalGames 2026: 5–15 % of accepted poses were over 0.5 m off (up to 8.7 m), and P0 had 4 odometry jumps.
 * Threshold: assumed from three logs; every log so far fires it.
 */
import { maxOf, percentile } from '../../match/series.ts'
import { pct, rule, round } from '../rule.ts'

export default rule({
  id: 'vision/outliers',
  title: 'Vision poses far from odometry',
  severity: 'warning',
  who: ['software'],
  fix: 'Reject vision poses more than ~0.5 m from odometry (or weight them by ambiguity and tag distance); check camera mounts and calibration.',
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
    if (distances.length < 20 || far / distances.length <= 0.05) return
    return {
      message: `${camera.name}: ${pct(far / distances.length)} of accepted vision poses were more than 0.5 m from odometry`,
      measured: [{ label: 'accepted poses > 0.5 m from odometry', value: round((100 * far) / distances.length, 1), unit: '%', threshold: 5 }],
      evidence: { 'accepted poses in the match': distances.length, 'over 0.5 m': far, 'p90 distance (m)': round(percentile(distances, 90)), 'farthest (m)': round(maxOf(distances)) },
    }
  },
})
