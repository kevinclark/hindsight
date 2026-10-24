/**
 * Does each mechanism's motor position agree with its absolute encoder?
 *
 * Checks (Foresight, the live pit check, only): for each mechanism the robot profile pairs with an absolute encoder,
 * the motor's position (median of the last 2 s) against the encoder's, converted to mechanism degrees. Fires above 2°.
 * Mechanisms with no absolute encoder are listed as not checked.
 * Measured: at rest on the field the 2026 intake pivot agreed with its CANcoder within 0.24° (median 0.04–0.08°);
 * while moving, up to 6.7° (the two signals are sampled at different moments). The 2° line is assumed.
 * Why: a zero seeded wrongly at boot (e.g. the motor set to the encoder's rotations rather than the mechanism's)
 * puts the mechanism 100° off; the robot then drives it into a hard stop.
 */
import { rule, round } from '../rule.ts'
import { CTRE_CANCODER, CTRE_REMOTE_SENSORS } from '../sources.ts'
import type { Problem } from '../rule.ts'

const MAX_OFF_DEGREES = 2
const AVERAGE_SECONDS = 2
/** More travel than this in the last 2 s (mechanism degrees) means it is being moved. Assumed. */
const MOVING_DEGREES = 1

export default rule({
  id: 'foresight/zero-sanity',
  title: 'Mechanism zero disagrees with its absolute encoder',
  severity: 'warning',
  judges: 'performance',
  foresightOnly: true,
  who: ['software', 'pit'],
  meaning: 'The motor thinks the mechanism is somewhere other than where its absolute encoder says it is, so position commands will drive it to the wrong place.',
  causes: [
    { id: 'seed', cause: 'The motor\'s position was set wrongly at start-up or by a zero command (e.g. in encoder rotations, not mechanism rotations)', look: 'the robot code\'s init and zero commands for this mechanism (resetEncoder / setPosition)' },
    { id: 'config', cause: 'The motor is not using the absolute encoder as its feedback, or the ratio between them is wrong', look: 'the motor\'s Feedback config in the code (RemoteCANcoder, SensorToMechanismRatio) and in Phoenix Tuner X' },
    { id: 'encoder', cause: 'The absolute encoder slipped or its magnet offset changed', look: 'the encoder\'s mounting and magnet; its MagnetOffset in Phoenix Tuner X' },
  ],
  nextStep: 'Power-cycle the robot so the motor re-seeds from the encoder, and check again; if it is still off, check the encoder\'s magnet offset in Phoenix Tuner X.',
  incident: 'Foresight proposal §5 (zero sanity); the intake pivot is seeded from its CANcoder at start-up (SlapdownSubsystem.slapdownInit)',
  sources: [
    { ...CTRE_REMOTE_SENSORS, says: 'SyncCANcoder checks the motor rotor against the remote CANcoder and reports when they differ significantly.' },
    { ...CTRE_CANCODER, says: 'The CANcoder\'s absolute-position zero offset is its Magnet Offset config, which Tuner X can write.' },
  ],
  thresholds: [
    { name: 'motor vs absolute encoder', value: 'more than 2°', basis: 'judgment', how: 'Assumed. Measured at rest on the field: the 2026 intake pivot agreed within 0.24° (median 0.04 to 0.08°); while moving, up to 6.7°.' },
    { name: 'position averaged over', value: 'the last 2 s', basis: 'judgment', how: 'Chosen.' },
  ],

  check(match) {
    const stretch = match.pitStretch
    const fp = match.profile.foresight
    if (!fp) return match.couldNotCheck('the robot profile names no mechanisms with absolute encoders')
    const recent = match.before(stretch.end, AVERAGE_SECONDS)
    const problems: Problem[] = []
    for (const zero of fp.zeroChecks) {
      if ('notCheckable' in zero) {
        match.checkedOnlyPart(`${zero.mechanism} not checked: ${zero.notCheckable}`)
        continue
      }
      const encoderRotations = match.signal(zero.absolute).median(recent) / (zero.absoluteUnit === 'radians' ? 2 * Math.PI : 1)
      const motor = match.signal(zero.motor)
      const motorRotations = motor.median(recent)

      // Being moved by hand: the two signals are sampled at different moments, so skip until it is still.
      const travelDegrees = (motor.highest(recent).value - motor.lowest(recent).value) * 360
      if (travelDegrees > MOVING_DEGREES) {
        match.checkedOnlyPart(`${zero.mechanism} not checked: it is moving (${travelDegrees.toFixed(1)}° in ${AVERAGE_SECONDS} s)`)
        continue
      }

      const degreesOff = degreesApart(encoderRotations, motorRotations, zero.sensorToMechanism)
      if (degreesOff <= MAX_OFF_DEGREES) continue
      problems.push({
        about: zero.mechanism,
        message: `${zero.mechanism}: the motor's position is ${degreesOff.toFixed(1)}° off its absolute encoder (more than ${MAX_OFF_DEGREES}°)`,
        at: stretch.end,
        measured: [{ label: 'motor vs absolute encoder', value: round(degreesOff, 1), unit: '°', threshold: MAX_OFF_DEGREES }],
        evidence: {
          'absolute encoder (rotations)': round(encoderRotations, 4),
          'motor (mechanism rotations)': round(motorRotations, 4),
          'encoder rotations per mechanism rotation': zero.sensorToMechanism,
          'set in': zero.where,
        },
      })
    }
    return problems
  },
})

/** How far apart the motor and the absolute encoder put the mechanism, in degrees of the mechanism. */
function degreesApart(encoderRotations: number, motorRotations: number, sensorToMechanism: number): number {
  let off = encoderRotations - motorRotations * sensorToMechanism
  off -= Math.round(off) // the absolute encoder wraps once per rotation
  return (Math.abs(off) / sensorToMechanism) * 360
}
