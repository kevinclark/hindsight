/**
 * Is the robot accepting vision poses far from where odometry says it is?
 *
 * Checks: each camera's accepted vision poses during the match against the odometry pose at the same moment.
 * Fires when more than 5 % are over 0.5 m away, out of at least 20 poses; with fewer, the camera is listed as not checked.
 * Why: CalGames 2026: 5–15 % of accepted poses were over 0.5 m off (up to 8.7 m), and P0 had 4 odometry jumps.
 * Threshold: assumed from three logs; every log so far fires it.
 *
 * When odometry was off the field for most of the far poses, the finding says so: those distances measure odometry
 * (a pose never seeded), not the camera. MTTD 2025 Q66: odometry started at (-4.7, -3.9) m, and 82-87 % "outliers".
 */
import type { Pose2d } from '../../readers/wpilog.ts'
import { maxOf, pct, percentile, plural, rule, round } from '../rule.ts'
import type { MatchView } from '../view.ts'
import { isTimeSyncAlert } from './time-sync.ts'

const MIN_POSES = 20 // fewer accepted poses than this can't give a rate worth acting on
const OFF_FIELD_METERS = 1 // past the field's edge by more than this, a robot pose is impossible (assumed: half a robot plus drift)

/** Is this pose off the field (the profile's field size)? False when the profile doesn't say how big the field is. */
function offField(match: MatchView, pose: Pose2d): boolean {
  const f = match.profile.game.field
  if (!f) return false
  const beyondX = pose.x < -OFF_FIELD_METERS || pose.x > f.length + OFF_FIELD_METERS
  const beyondY = pose.y < -OFF_FIELD_METERS || pose.y > f.width + OFF_FIELD_METERS
  return beyondX || beyondY
}

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
    let farOffField = 0 // far poses taken while odometry was off the field
    vision.series.v.forEach((pose, i) => {
      const t = vision.series.t[i]
      const odo = odometry.at(t)
      if (!match.inMatch(t) || !odo) return
      const distance = Math.hypot(pose.x - odo.x, pose.y - odo.y)
      distances.push(distance)
      if (distance > 0.5 && offField(match, odo)) farOffField++
    })
    const far = distances.filter((d) => d > 0.5).length
    if (distances.length < MIN_POSES) {
      return match.couldNotCheck(`only ${plural(distances.length, 'accepted pose')} in the match (needs ${MIN_POSES} for a rate)`)
    }
    if (far / distances.length <= 0.05) return

    // Alerts about unsynced camera clocks (vision/time-sync) point at the clock first. A time-sync alert during the
    // match rules nothing in (it fires on most logs), but its absence rules it out.
    const clockAlerts = match.alerts().some((a) => isTimeSyncAlert(a) && a.onsetsInMatch.length > 0)
    const ruledOut: Record<string, string> = {}
    if (!clockAlerts) ruledOut['time-sync'] = 'no time-sync alert during the match'

    // Odometry off the field for most of the far poses: the distances measure odometry, not the camera.
    const odometryOff = farOffField > far / 2
    const start = match.autoStart === null ? undefined : odometry.at(match.autoStart)
    let likely: string[] | undefined
    let nextStep: string | undefined
    let offFieldNote = ''
    if (odometryOff) {
      likely = ['odometry']
      offFieldNote = `; odometry was off the field for ${farOffField} of them`
      let whatToDo = 'Find where odometry left the field (the Match tab), fix that, then look at vision again.'
      if (start && offField(match, start)) {
        whatToDo = `It started auto at ${where(start)}: set the robot's starting pose in every auto, then look at vision again.`
      }
      nextStep = `Odometry was off the field for ${farOffField} of the ${far} far poses, so these distances measure odometry, not the camera. ${whatToDo}`
    }

    const farPercent = (100 * far) / distances.length
    return {
      likely,
      nextStep,
      ruledOut,
      message: `${camera.name}: ${pct(far / distances.length)} of accepted vision poses were more than 0.5 m from odometry${offFieldNote}`,
      measured: [{ label: 'accepted poses > 0.5 m from odometry', value: round(farPercent, 1), unit: '%', threshold: 5 }],
      evidence: {
        'accepted poses in the match': distances.length,
        'over 0.5 m': far,
        'p90 distance (m)': round(percentile(distances, 90)),
        'farthest (m)': round(maxOf(distances)),
        'over 0.5 m while odometry was off the field': odometryOff ? farOffField : undefined,
        'odometry when auto started (m)': odometryOff && start ? where(start) : undefined,
      },
    }
  },
})

/** A pose's position in words: "(1.2, 3.4) m". */
function where(pose: Pose2d): string {
  return `(${pose.x.toFixed(1)}, ${pose.y.toFixed(1)}) m`
}
