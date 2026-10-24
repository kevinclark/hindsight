/**
 * Did a motor push hard without turning?
 *
 * Checks: each motor of a group the robot profile marks `neverStalls` (a turret: nothing to hold, no game piece to
 * grip), while enabled: stretches longer than 0.5 s with stator current above 30 A and speed under 0.2 rot/s. Fires on
 * one or more. With the group's `setpoint`, the longest stall says which: short of the setpoint by more than 10°, a
 * jam; at the setpoint, pushing a stop there (the code parks it past a hard stop).
 * Other groups are not checked: on the 2025 offseason robot the elevator, the intake pivot and the rollers sat above
 * 30 A without turning (holding against gravity, resting on a stop, holding a game piece) for more than 0.5 s in 47 of
 * its 78 logs, for up to 68 s.
 * Measured on the turret, 170 practice logs of 2026-02-19..22: the jam (one log) stalled it 6 times mid-travel, up to
 * 13.4 s, its setpoint 3–251° away (53° at the longest); no other mid-travel stall lasted more than 0.18 s. Parked at
 * its -270° soft limit it stalled 15 times in 10 logs (0.7–14.7 s, up to 53 A), setpoint within 6°. The 30 A and
 * 0.2 rot/s lines come from the jam; for any other motor they are assumed. The 10° line is assumed.
 * Why: 2026-02-21 practice: a screw jammed the turret, and no rule caught it.
 */
import { above, beyond, nearZero, plural, round, rule, secs, totalSeconds } from '../rule.ts'
import { CTRE_CURRENT_LIMITS, WCP_KRAKEN_PERFORMANCE } from '../sources.ts'
import type { Episode, MatchView, MotorView } from '../view.ts'

const STALL_AMPS = 30 // stator current; measured (the turret jam peaked at 45–53 A)
const STILL_ROT_PER_S = 0.2 // speed, in the units the velocity key logs (turret rotations/s for the 2026 turret)
// Faster than this at any moment while enabled, the motor was used in the match. Assumed: of 45 local logs whose turret
// never passed STILL_ROT_PER_S, 31 read exactly 0 and 14 peaked at 0.012–0.178 rot/s (12 of them above 0.05).
const TURNED_ROT_PER_S = 0.05
const LONGER_THAN_SECONDS = 0.5 // measured: jam stalls 0.9–13.4 s, every other mid-travel turret stall 0.18 s or less
const AT_SETPOINT_DEGREES = 10 // closer than this to its setpoint, it is pushing a stop, not jammed; assumed

export default rule({
  id: 'mech/stall',
  title: 'Motor stalled',
  severity: 'warning',
  judges: 'performance',
  who: ['pit'],
  meaning: 'The motor pushed hard but did not turn. A stalled motor heats up fast and draws current the rest of the robot needs.',
  causes: [
    { id: 'jam', cause: 'Something caught in the mechanism (a screw, a zip tie, a game piece, a wire)', look: 'the mechanism itself: turn it by hand with the robot off and feel for a tight spot' },
    { id: 'hard-stop', cause: 'The code sends it past a hard stop (or a cable or bracket), so it pushes there', look: 'the mechanism\'s soft limits in the code against where it really stops; turn it by hand to that end' },
    { id: 'bearing', cause: 'A bearing, gear or belt binding', look: 'the gearbox and bearings: grinding, a cracked plate, a belt too tight' },
  ],
  nextStep: 'With the robot off, turn the mechanism by hand through its whole range and find what stops it.',
  incident: '2026-02-21 practice: a screw jammed the turret, stalled 13.4 s at 45 A (failure-detection-measurements §6)',
  sources: [
    { ...WCP_KRAKEN_PERFORMANCE, says: 'Kraken X60 stall: 7.09 Nm at 366 A with trapezoidal commutation, 9.37 Nm at 483 A with FOC.' },
    { ...CTRE_CURRENT_LIMITS, says: 'Stator limits cap output torque, help prevent wheel slip and reduce motor heat.' },
  ],
  thresholds: [
    { name: 'stator current', value: 'above 30 A', basis: 'measured', how: 'The turret jam peaked at 45 to 53 A (170 practice logs of 2026-02-19 to 22); for any other motor the line is assumed.' },
    { name: 'speed', value: 'under 0.2 rot/s', basis: 'measured', how: 'From the same jam; assumed for any other motor.' },
    { name: 'stall length', value: 'longer than 0.5 s', basis: 'measured', how: 'Jam stalls lasted 0.9 to 13.4 s; every other mid-travel turret stall lasted 0.18 s or less.' },
    { name: 'distance from the setpoint for a jam', value: 'more than 10°', basis: 'judgment', how: 'Assumed.' },
  ],
  forEach: 'motor',

  // Only motors the robot profile says never push a hard stop: any stall there is a jam.
  only: (motor, match) => !!groupOf(motor, match)?.neverStalls,
  check(motor, match) {
    const setpoint = groupOf(motor, match)?.setpoint
    const found = stalls(motor, match)
    // A motor that never turned while enabled was never asked to: it can't show it doesn't stall.
    if (found.length === 0 && !turned(motor, match)) return match.couldNotCheck('it never turned while enabled')
    if (found.length === 0) return

    const longest = found.reduce((a, b) => (b.seconds > a.seconds ? b : a))
    const highest = motor.stator().highest(match.between(longest.start, longest.end)).value
    const short = setpoint ? degreesShort(setpoint, longest, match) : NaN
    const likely: string[] = []
    if (short > AT_SETPOINT_DEGREES) likely.push('jam')
    if (short <= AT_SETPOINT_DEGREES) likely.push('hard-stop')
    const where = Number.isFinite(short) ? `, ${short.toFixed(0)}° short of its setpoint` : ''

    return {
      message: `${motor.name} stalled ${plural(found.length, 'time')} (stator above ${STALL_AMPS} A, not turning), `
        + `the longest ${secs(longest.seconds)} ${match.whenAt(longest.start)}${where}`,
      at: longest.start,
      likely,
      evidence: {
        'stalls longer than 0.5 s': found.length,
        'seconds stalled in all': round(totalSeconds(found), 1),
        'longest stall (s)': round(longest.seconds, 1),
        'highest stator current in it (A)': round(highest, 0),
        'short of the setpoint in it (°)': Number.isFinite(short) ? round(short, 0) : undefined,
      },
      measured: [{ label: 'longest stall', value: round(longest.seconds, 1), unit: 's', threshold: LONGER_THAN_SECONDS }],
      plot: { signals: [motor.stator(), motor.velocity()], unit: 'A, rot/s', to: longest.end + 2 },
    }
  },
})

/** Stretches while enabled when the motor drew more than STALL_AMPS without turning, longer than LONGER_THAN_SECONDS. */
function stalls(motor: MotorView, match: MatchView): Episode[] {
  const pushing = motor.stator().episodes(above(STALL_AMPS), { during: match.enabled })
  return motor.velocity().episodes(nearZero(STILL_ROT_PER_S), { during: pushing, longerThan: LONGER_THAN_SECONDS })
}

const groupOf = (motor: MotorView, match: MatchView) => match.profile.motorGroups.find((g) => g.name === motor.group)

/** Did the motor turn at all while enabled? */
function turned(motor: MotorView, match: MatchView): boolean {
  return motor.velocity().episodes(beyond(TURNED_ROT_PER_S), { during: match.enabled }).length > 0
}

/** How far the mechanism sat from its setpoint, in degrees, halfway through a stall (NaN if either isn't logged). */
function degreesShort(keys: { position: string; setpoint: string; toDegrees: number }, stall: Episode, match: MatchView) {
  const middle = (stall.start + stall.end) / 2
  const position = match.signalIfLogged(keys.position)?.at(middle) ?? NaN
  const setpoint = match.signalIfLogged(keys.setpoint)?.at(middle) ?? NaN
  return Math.abs(setpoint - position) * keys.toDegrees
}
