/**
 * Links: when one finding explains another in the same match. The app shows the explained finding under the one
 * that explains it, so a student reading a bad match sees one story instead of several unrelated reds. Nothing is
 * deleted: the explained finding keeps its evidence and plot, one click away, and every count still counts it.
 *
 * Each link names two rules and says when a finding of the first explains a finding of the second, measured on the
 * real matches named above it. A finding gets at most one explanation: the first link here that matches.
 * To add one, copy a link, then run `npm run golden` before and after and look at every finding that changed.
 */
import { isBetween, link, likely, mostLikely, secondsAfter, within, type Link } from './rule.ts'
import type { Finding } from './types.ts'
import { BUS_DEVICES } from './can/bus-dropout.ts'
import { GROUP_DEVICES } from './parents.ts'

export const LINKS: Link[] = [
  // CalGames 2026 P0 and MTTD 2025 Q61: the battery collapsed, so the robot browned out.
  link({
    cause: 'power/battery-collapse',
    explains: 'power/brownout',
    // No time test: the brownout ranks the weak battery first from the same health check the collapse comes from.
    when: (collapse, brownout) => mostLikely(brownout, 'weak-battery'),
    why: 'the battery collapsed under load, so the voltage fell below the brownout level',
  }),
  // CalGames 2026 P0: flywheel follower 16 dropped off CAN 2.5 s after the first brownout, with the battery low.
  link({
    cause: 'power/brownout',
    explains: 'can/device-dropout',
    // The drop started no more than 1 s before the first brownout (or any time after it).
    when: (brownout, dropout) => likely(dropout, 'battery-sag') && secondsAfter(brownout, dropout) >= -1,
    why: 'the device lost power in the brownout',
  }),
  // CalGames 2026 P0, MTTD 2025 Q61 and one public log: the lowest voltage was the brownout itself.
  link({
    cause: 'power/brownout',
    explains: 'power/margin',
    when: (brownout, margin) => Number(margin.evidence['margin (V)']) <= 0,
    why: 'the voltage went below the brownout setting, so there was no margin left',
  }),
  // CalGames 2026 Q13: the hood moved before its zero finished, then hit the trench bar 11 s later, in auto.
  // A zero that never finished counts only for a tilt in auto: in teleop a tilt is more often a bump or a push.
  link({
    cause: 'mech/zero-not-completed',
    explains: 'collision/tilt',
    when: (zero, tilt) => duringWrongFrame(zero, tilt),
    why: 'the mechanism was moving from the wrong zero, so it went somewhere it should not have',
  }),
  // CalGames 2026 Q13: wedged at −24° for 0.8 s, then disabled 0.8 s after the tilt began.
  link({
    cause: 'collision/tilt',
    explains: 'auto/early-disable',
    when: (tilt, disable) => likely(disable, 'wedged') && isBetween(secondsAfter(tilt, disable), 0, 3),
    why: 'the robot was wedged, so it was disabled',
  }),
  // CalGames 2026 Q13: the DS log stopped 3 s into the comms loss. It is evidence for the loss, not a second problem.
  link({
    cause: 'comms/loss',
    explains: 'comms/ds-log-truncated',
    when: (loss) => likely(loss, 'ds-laptop'),
    why: 'the Driver Station stopping is what lost comms',
  }),
  // CalGames 2026 P0: "Flywheel Follower Disconnected" came on at the moment follower 16 dropped off CAN.
  link({
    cause: 'can/device-dropout',
    explains: 'alerts/passthrough',
    when: (dropout, alert) => alertNames(alert, dropout.about) && within(dropout, alert, 1),
    why: 'the robot code saw the same device drop off CAN',
  }),
  // CalGames 2026 Q21: two Back_Right camera alerts came on at the moment the camera dropped out.
  link({
    cause: 'vision/stale',
    explains: 'alerts/passthrough',
    when: (camera, alert) => alertNames(alert, camera.about) && within(camera, alert, 1),
    why: 'the robot code saw the same camera drop out',
  }),
  // MTTD 2025 Q41: "Missing Module Data" and "Missing Gyro Data" came on 0.85 s before the bus's devices reported
  // the drop (the code sees missing values before a device's Connected flag times out). "Using Sync Odometry" came
  // on too, but it also comes on once in 7 of the 14 other matches that log it, with no bus drop. So the alert
  // must name a kind of device on the bus, not just come on at the same time.
  link({
    cause: 'can/bus-dropout',
    explains: 'alerts/passthrough',
    when: (bus, alert) => namesAKindOfDevice(bus.evidence[BUS_DEVICES], alert) && within(bus, alert, 2),
    why: 'the robot code saw the devices on the bus go missing',
  }),
  // CalGames 2026 Q2 with no CAN bus in the robot profile: the same 12 swerve "Disconnected ... module" alerts and
  // "Missing Module Data" came on with the 25 devices that dropped together (a parent, parents.ts), as with the bus.
  link({
    cause: 'can/devices-dropped-together',
    explains: 'alerts/passthrough',
    when: (group, alert) => namesAKindOfDevice(group.evidence[GROUP_DEVICES], alert) && within(group, alert, 2),
    why: 'the robot code saw the devices go missing',
  }),
]

/**
 * Does the alert's text name this thing? A trailing CAN id may be left out: "Flywheel Follower Disconnected" names
 * "Flywheel follower 16", but "Flywheel Follower 17 Disconnected" doesn't.
 */
function alertNames(alert: Finding, name: string | null): boolean {
  if (!alert.about || !name) return false
  const id = name.match(/\s(\d+)$/)?.[1]
  const withoutId = name.replace(/\s+\d+$/, '').toLowerCase()
  const numbers: string[] = alert.about.match(/\d+/g) ?? []
  const sameId = id === undefined || numbers.length === 0 || numbers.includes(id)
  return alert.about.toLowerCase().includes(withoutId) && sameId
}

/** Where a device sits on the robot, which says nothing about what kind of device it is. */
const POSITIONS = ['front', 'back', 'left', 'right']

/**
 * Does the alert name a kind of device in this list (a finding's evidence line, "Front Left drive, Gyro (Pigeon)")?
 * "Missing Gyro Data" names "Gyro (Pigeon)", and "Missing Module Data" names "Front Left steer" (where a device sits
 * doesn't count).
 */
function namesAKindOfDevice(devices: number | string | undefined, alert: Finding): boolean {
  const kinds = wordsOf(String(devices ?? '')).filter((w) => !POSITIONS.includes(w))
  return wordsOf(alert.about ?? '').flatMap((w) => [w, ...(ALERT_WORDS[w] ?? [])]).some((w) => kinds.includes(w))
}

/**
 * Words an alert uses for a kind of device that the profile names differently (CalGames 2026 Q2: "Disconnected turn
 * motor on Back Left module!" is the device the profile calls "Back Left steer"; "turn encoder" is its CANcoder).
 */
const ALERT_WORDS: Record<string, string[]> = { turn: ['steer'], encoder: ['cancoder'], module: ['steer'] }

/** The words in a text, in lower case: "Gyro (Pigeon)" → ['gyro', 'pigeon']. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0)
}

/**
 * Did the tilt start while the mechanism was moving from the wrong zero (from its first move until its zero)? When
 * the zero never finished, only a tilt in auto counts.
 */
function duringWrongFrame(zero: Finding, tilt: Finding): boolean {
  const zeroDone = zero.evidence['zero completed (robot time, s)']
  const tiltAt = tilt.time ?? NaN
  const afterTheMove = tiltAt >= (zero.time ?? NaN)
  if (typeof zeroDone === 'number') return afterTheMove && tiltAt <= zeroDone
  return afterTheMove && tilt.evidence.phase === 'auto'
}
