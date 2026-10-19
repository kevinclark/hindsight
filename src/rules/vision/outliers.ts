/**
 * vision/outliers — is the robot accepting vision poses far from where odometry says it is?
 *
 * Checks: for each camera, the accepted vision pose against the odometry pose at the same moment, during the
 * match. Fires when more than 5 % of a camera's accepted poses are over 0.5 m away.
 * Why: CalGames 2026: 5–15 % of accepted poses were > 0.5 m off (max 2.2–8.7 m), and P0 had 4 odometry jumps.
 * Threshold: assumed from three logs; every log so far fires it.
 * When it fires: tighten the pose rejection (ambiguity, distance, max jump vs odometry) and check camera mounts
 * and calibration.
 */
import { has, values, type Match } from '../../match/match.ts'
import { heldAt, percentile } from '../../match/series.ts'
import type { Pose2d } from '../../readers/wpilog.ts'
import { inMatch } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

const FAR_METERS = 0.5
const SHARE = 0.05

export const visionOutliers: Rule = {
  id: 'vision/outliers',
  title: 'Vision poses far from odometry',
  fix: 'Reject vision poses more than ~0.5 m from odometry (or weight them by ambiguity and tag distance); check camera mounts and calibration.',
  incident: 'CalGames 2026: 5–15 % of accepted vision poses > 0.5 m from odometry (P0 analysis, "Other issues")',
  needs: (m: Match) => [m.profile.signals.odometryPose, ...m.profile.cameras.map((c) => c.acceptedPose)],
  run(m: Match): Finding[] {
    const odometry = values<Pose2d>(m, m.profile.signals.odometryPose)!
    const out: Finding[] = []
    for (const cam of m.profile.cameras) {
      if (!has(m, cam.acceptedPose)) continue
      const poses = values<Pose2d>(m, cam.acceptedPose)!
      const distances: number[] = []
      for (let i = 0; i < poses.t.length; i++) {
        if (!inMatch(m, poses.t[i])) continue
        const o = heldAt(odometry, poses.t[i])
        if (o) distances.push(Math.hypot(poses.v[i].x - o.x, poses.v[i].y - o.y))
      }
      const far = distances.filter((d) => d > FAR_METERS).length
      const share = distances.length ? far / distances.length : 0
      if (share <= SHARE) continue
      out.push({
        rule: this.id,
        severity: 'warning',
        title: `${cam.name}: ${(100 * share).toFixed(1)} % of accepted vision poses were more than ${FAR_METERS} m from odometry`,
        time: null,
        evidence: {
          'accepted poses in the match': distances.length,
          [`over ${FAR_METERS} m`]: far,
          'p90 distance (m)': +percentile(distances, 90).toFixed(2),
          'max distance (m)': +Math.max(...distances).toFixed(2),
        },
      })
    }
    return out
  },
}
