/**
 * The same scenario did the same thing on red as on blue. Field coordinates have their origin at the blue wall, so a
 * robot driving away from its own driver station moves +x on blue and −x on red, whether the field is rotated or
 * mirrored between alliances; only the sign of x is compared (y differs between the two kinds of field).
 *
 * For each enabled stretch of the scenario: it fires when the robot made the same move on both alliances (same
 * direction in x, and the two moves nearly equal), or, when it only turned (a heading reset), ended facing the same
 * way from the same start. Two moves that differ (an auto that barely moves in sim, steering differently each run) are not compared:
 * measured on 26Off, two such autos moved 1 m with x the same sign and y 0.88 m vs 0.15 m. The heading comparison
 * assumes a rotated field, or a heading reset: on a mirrored field a correctly flipped turn to 90° ends at 90° on
 * both.
 *
 * Why: Rebuilt 327a449 (`getAlliance().equals(Alliance.Blue)` is always false, so the blue heading reset set red's
 * heading) and the 2026-03-04 red-alliance drive fix.
 */

import { isEnabled } from '../events.ts'
import { headingGap, movement, RESET_SETTLE_SECONDS, type Movement } from './pose.ts'
import { type Check, type Finding, type RunResult } from './types.ts'

/**
 * Assumed: under 0.5 m of x travel is not a direction (measured: a robot standing still through a 3 s teleop step
 * moved under 0.01 m, Rebuilt, 6 runs).
 */
const MOVED_METERS = 0.5
/** Assumed: an unflipped path replays the same move on red, so the two moves differ by under a third of their size. */
const SAME_MOVE_SHARE = 0.35
const TURNED_DEGREES = 20

export const alliances: Check = ({ results, poseKey }) => {
  // Each repeat's blue run is compared with the same repeat's red run.
  const pairs = new Set(results.map((r) => `${r.run.scenario.name}#${r.repeat}`))
  return [...pairs].flatMap((pair): Finding[] => {
    const runs = results.filter((r) => `${r.run.scenario.name}#${r.repeat}` === pair && r.record.ended)
    const blue = runs.find((r) => r.run.alliance.startsWith('Blue'))
    const red = runs.find((r) => r.run.alliance.startsWith('Red'))
    if (!blue || !red) return []
    const stretches = (r: RunResult) => r.record.periods.filter(isEnabled)
    return stretches(blue).flatMap((b, i) => {
      const rd = stretches(red)[i]
      const onBlue = rd && movement(blue.log, poseKey, b.start + RESET_SETTLE_SECONDS, b.end)
      const onRed = rd && movement(red.log, poseKey, rd.start + RESET_SETTLE_SECONDS, rd.end)
      if (!onBlue || !onRed) return []
      const same = sameOnBoth(onBlue, onRed)
      if (!same) return []
      return [{
        check: 'alliance/same-on-both', severity: 'error', run: blue.run.label.replace(/ \(blue\)/, ''),
        message: `${b.mode === 'auto' ? 'Auto' : 'Teleop'} did the same thing on red as on blue: ${same}.`,
        details: [`blue: ${describe(onBlue)}`, `red: ${describe(onRed)}`],
        look: 'every DriverStation.getAlliance() use on this path: is red flipped (and is the Optional compared with .orElse, not .equals)?',
      }]
    })
  })
}

/** Why the two runs look unflipped, or null when they look flipped (or there's nothing to compare). */
function sameOnBoth(blue: Movement, red: Movement): string | null {
  const bothMoved = Math.abs(blue.dx) >= MOVED_METERS && Math.abs(red.dx) >= MOVED_METERS
  if (bothMoved) {
    const gap = Math.hypot(blue.dx - red.dx, blue.dy - red.dy)
    const same = Math.sign(blue.dx) === Math.sign(red.dx) && gap <= SAME_MOVE_SHARE * Math.max(blue.distance, red.distance)
    return same ? `both drove ${blue.dx > 0 ? '+x (toward red)' : '−x (toward blue)'}` : null
  }
  const turned = Math.abs(headingGap(blue.headingStart, blue.headingEnd)) >= TURNED_DEGREES || Math.abs(headingGap(red.headingStart, red.headingEnd)) >= TURNED_DEGREES
  // Unflipped, red starts where blue does too: a run that started flipped (an auto's start pose) isn't the same move.
  const sameStart = headingGap(blue.headingStart, red.headingStart) < TURNED_DEGREES
  if (turned && sameStart && headingGap(blue.headingEnd, red.headingEnd) < TURNED_DEGREES) return `both ended facing ${blue.headingEnd.toFixed(0)}°`
  return null
}

function describe(m: Movement): string {
  return `moved ${m.dx.toFixed(2)} m in x, ${m.dy.toFixed(2)} m in y; heading ${m.headingStart.toFixed(0)}° → ${m.headingEnd.toFixed(0)}°`
}
