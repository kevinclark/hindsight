/** The robot's pose from a run's log: where it was at a time, and how far it moved in a stretch. */

import { readNumbers, type WpilogFile } from '../../readers/wpilog.ts'
import { valueAt } from '../../match/series.ts'

/**
 * Autos reset odometry to their start pose as they begin: measured on 26Off (3 runs, 2026-10-21), two jumps, the
 * last 0.04–0.06 s after enable. Movement in an enabled stretch is measured from this long after it starts.
 */
export const RESET_SETTLE_SECONDS = 0.25

export interface Movement { dx: number; dy: number; distance: number; headingStart: number; headingEnd: number }

/** How the pose changed from `start` to `end` (meters, degrees), or null when the log has no pose. */
export function movement(log: WpilogFile | null, poseKey: string | null, start: number, end: number): Movement | null {
  if (!log || !poseKey) return null
  const x = readNumbers(log, `${poseKey}/translation/x`)
  const y = readNumbers(log, `${poseKey}/translation/y`)
  const heading = readNumbers(log, `${poseKey}/rotation/value`)
  if (!x || !y || !heading || x.t.length === 0) return null
  const dx = valueAt(x, end) - valueAt(x, start)
  const dy = valueAt(y, end) - valueAt(y, start)
  const degrees = (t: number) => (valueAt(heading, t) * 180) / Math.PI
  return { dx, dy, distance: Math.hypot(dx, dy), headingStart: degrees(start), headingEnd: degrees(end) }
}

/** The smallest angle between two headings, degrees (0–180). */
export function headingGap(a: number, b: number): number {
  const turn = (((a - b) % 360) + 360) % 360
  return turn > 180 ? 360 - turn : turn
}

/** The robot pose's log key: the profile's, else the one Pose2d under /RealOutputs/Odometry or named like a robot pose. */
export function findPoseKey(log: WpilogFile | null, profileKey: string | null): string | null {
  if (!log) return null
  if (profileKey && log.entries.has(profileKey)) return profileKey
  const poses = [...log.entries.values()].filter((e) => e.type === 'struct:Pose2d' && e.name.startsWith('/RealOutputs/')).map((e) => e.name)
  return poses.find((n) => /\/Odometry\/Robot$/.test(n)) ?? poses.find((n) => /Odometry|RobotPose|EstimatedPose/i.test(n)) ?? null
}
