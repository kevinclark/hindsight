/**
 * Did a motor push hard without turning?
 *
 * Checks: each motor of a group the robot profile marks `neverStalls` (a turret: nothing to hold, no hard stop to rest
 * on), while enabled: stretches longer than 0.5 s with stator current above 30 A and speed under 0.2 rot/s. Fires on
 * one or more. Other groups are not checked: on the 2025 offseason robot the elevator, the intake pivot and the
 * rollers sat above 30 A without turning (holding against gravity, resting on a stop, holding a game piece) for more
 * than 0.5 s in 47 of its 78 logs, for up to 68 s.
 * Measured on the 55 practice logs of 2026-02-21: the turret jam stalled the turret this way twice in one log (longest
 * 0.9 s) and 6 times in the next (longest 13.4 s); no other turret stall in those logs lasted more than 0.18 s. The
 * 30 A and 0.2 rot/s lines come from that jam; for any other motor they are assumed.
 * Why: 2026-02-21 practice: a screw jammed the turret, and no rule caught it.
 */
import { above, nearZero, plural, round, rule, secs, totalSeconds } from '../rule.ts'
import type { Problem } from '../rule.ts'
import type { MatchView, MotorView } from '../view.ts'

const STALL_AMPS = 30 // stator current; measured (the turret jam peaked at 45–53 A)
const STILL_ROT_PER_S = 0.2 // speed, in the units the velocity key logs (turret rotations/s for the 2026 turret)
const LONGER_THAN_SECONDS = 0.5 // measured: jam stalls 0.9–13.4 s, every other turret stall 0.18 s or less

export default rule({
  id: 'mech/stall',
  title: 'Motor stalled',
  severity: 'warning',
  who: ['pit'],
  meaning: 'The motor pushed hard but did not turn, so something stopped the mechanism. A stalled motor also heats up fast and draws current the rest of the robot needs.',
  causes: [
    { id: 'jam', cause: 'Something caught in the mechanism (a screw, a zip tie, a game piece, a wire)', look: 'the mechanism itself: turn it by hand with the robot off and feel for a tight spot' },
    { id: 'hard-stop', cause: 'The code drove it into a hard stop or past its soft limits', look: 'the mechanism\'s setpoint and position in AdvantageScope at that moment; its soft limits in the code' },
    { id: 'bearing', cause: 'A bearing, gear or belt binding', look: 'the gearbox and bearings: grinding, a cracked plate, a belt too tight' },
  ],
  nextStep: 'With the robot off, turn the mechanism by hand through its whole range and find what stops it.',
  incident: '2026-02-21 practice: a screw jammed the turret, stalled 13.4 s at 45 A (failure-detection-measurements §6)',
  forEach: 'motorGroup',

  check(group, match) {
    if (!group.neverStalls) return
    const problems: Problem[] = []
    for (const motor of group.motors) {
      const found = stalls(motor, match)
      if (found.length === 0) continue
      const longest = found.reduce((a, b) => (b.seconds > a.seconds ? b : a))
      const highest = motor.stator().highest(match.between(longest.start, longest.end)).value
      problems.push({
        about: motor.name,
        message: `${motor.name} stalled ${plural(found.length, 'time')} (stator above ${STALL_AMPS} A, not turning), the longest ${secs(longest.seconds)} ${match.whenAt(longest.start)}`,
        at: longest.start,
        evidence: {
          'stalls longer than 0.5 s': found.length,
          'seconds stalled in all': round(totalSeconds(found), 1),
          'longest stall (s)': round(longest.seconds, 1),
          'highest stator current in it (A)': round(highest, 0),
        },
        measured: [{ label: 'longest stall', value: round(longest.seconds, 1), unit: 's', threshold: LONGER_THAN_SECONDS }],
        plot: { signals: [motor.stator(), motor.velocity()], unit: 'A, rot/s', to: longest.end + 2 },
      })
    }
    return problems
  },
})

/** Stretches while enabled when the motor drew more than STALL_AMPS without turning, longer than LONGER_THAN_SECONDS. */
function stalls(motor: MotorView, match: MatchView) {
  const pushing = motor.stator().episodes(above(STALL_AMPS), { during: match.enabled })
  return motor.velocity().episodes(nearZero(STILL_ROT_PER_S), { during: pushing, longerThan: LONGER_THAN_SECONDS })
}
