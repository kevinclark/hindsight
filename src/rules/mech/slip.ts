/**
 * Did a motor turn while its mechanism stayed put?
 *
 * Checks: for each mechanism in the profile's `slipChecks` (a motor position and an absolute angle of the same
 * mechanism), every whole second while enabled: the motor's travel and the absolute angle's travel, both in degrees of
 * the mechanism. A second is a slip when the motor moved more than 30°, the absolute angle less than a tenth of that,
 * and the gap between the two (motor minus absolute) changed by more than half the motor's travel from one second
 * before to one second after (a slip leaves the motor off the mechanism; lag during a fast swing, or one bad sample,
 * does not). Fires on one or more.
 * Measured on the 55 practice logs of 2026-02-21 (turret): in the 39 logs before the drive gear fell off or after it
 * was fixed, no second with the motor past 30° had the turret follow by less than a tenth (lag and backlash keep it
 * at a tenth or more); after it fell off, every such second did, the turret moving 5.1° at most. Both lines measured.
 * The before-and-after test was added after two false slips in the held-out logs of 2026-02-19/20/22, both in
 * fast swings (about 250° in half a second): the absolute angle lagged the motor by up to 108° and caught up within
 * a second, and in the other it read 268° off for one record.
 * Seconds are counted from each enable, so a slip split across two seconds needs more than 30° in one of them; the
 * slips seen were 30–261° in a second and repeated, so a log with one is caught.
 * Why: 2026-02-21 practice: the turret's drive gear fell off; the motor spun and the turret stayed where it was.
 */
import { plural, round, rule } from '../rule.ts'
import { CTRE_CANCODER, CTRE_REMOTE_SENSORS } from '../sources.ts'
import type { Problem } from '../rule.ts'
import type { MatchView } from '../view.ts'
import type { SlipCheck } from '../../profiles/types.ts'

const WINDOW_SECONDS = 1
const MOTOR_DEGREES = 30 // the motor's travel in one second, in mechanism degrees; measured
const FOLLOWS_AT_LEAST = 0.1 // the absolute angle's travel as a share of the motor's; below it, slip; measured
const STILL_OFF_SHARE = 0.5 // the motor-minus-absolute gap must change by this share of the motor's travel; assumed

export default rule({
  id: 'mech/slip',
  title: 'Motor turned but the mechanism did not',
  severity: 'warning',
  who: ['pit'],
  needsProfile: true,
  meaning: 'The motor turned but its absolute encoder says the mechanism stayed where it was: the drive between them is slipping or disconnected, so the mechanism is not where the code thinks it is.',
  causes: [
    { id: 'drive-loose', cause: 'A gear, pulley or sprocket loose or off its shaft (a set screw, a sheared key or pin, a belt jumped)', look: 'the mechanism\'s gears and pulleys: hold the mechanism and turn the motor shaft by hand' },
    { id: 'absolute-stuck', cause: 'The absolute encoder (or the angle the code computes from it) stopped following the mechanism', look: 'the encoder\'s Connected flag and its magnet; the absolute angle in AdvantageScope while you turn the mechanism by hand' },
  ],
  nextStep: 'Hold the mechanism still and turn its motor by hand: if the motor turns freely, find the loose gear or pulley.',
  incident: '2026-02-21 practice: the turret drive gear fell off; the motor turned up to 261° in a second while the turret moved 0.2° (failure-detection-measurements §6)',
  sources: [
    { ...CTRE_REMOTE_SENSORS, says: 'SyncCANcoder keeps monitoring the remote CANcoder and reports if the two positions differ significantly, which suits a mount that could break and still report plausible data.' },
    { ...CTRE_CANCODER, says: 'The CANcoder\'s absolute position is zeroed with its Magnet Offset config.' },
  ],
  thresholds: [
    { name: 'motor travel in a second', value: 'more than 30°', basis: 'measured', how: 'The 55 practice logs of 2026-02-21 (turret): in the 39 logs before the drive gear fell off or after the fix, no second with the motor past 30° had the turret follow by less than a tenth.' },
    { name: 'absolute angle follows by', value: 'less than a tenth of the motor travel', basis: 'measured', how: 'Same logs: lag and backlash keep it at a tenth or more; after the gear fell off the turret moved 5.1° at most.' },
    { name: 'gap between motor and absolute angle changes by', value: 'more than half the motor travel', basis: 'judgment', how: 'Assumed. Added after two false slips in held-out logs, both in fast swings.' },
  ],

  check(match) {
    const checks = match.profile.slipChecks ?? []
    if (checks.length === 0) return match.couldNotCheck('the robot profile pairs no motor with an absolute angle (slipChecks)')
    const problems: Problem[] = []
    for (const pair of checks) {
      const slips = slipSeconds(pair, match)
      if (slips.length === 0) continue
      const worst = slips.reduce((a, b) => (b.motor > a.motor ? b : a))
      problems.push({
        about: pair.mechanism,
        message: `${pair.mechanism}: the motor turned ${worst.motor.toFixed(0)}° in a second ${match.whenAt(worst.start)} `
          + `while the mechanism moved ${worst.absolute.toFixed(1)}° (${plural(slips.length, 'second')} like this)`,
        at: worst.start,
        evidence: {
          'seconds the motor turned and the mechanism did not': slips.length,
          'motor travel in the worst second (°)': round(worst.motor, 0),
          'absolute angle travel in that second (°)': round(worst.absolute, 1),
          'absolute angle from': pair.where,
        },
        measured: [{ label: 'seconds slipping', value: slips.length, unit: 's', threshold: 1 }],
        plot: {
          signals: [
            match.signal(pair.motor).times(pair.motorToDegrees, `${pair.mechanism} motor (°)`),
            match.signal(pair.absolute).times(pair.absoluteToDegrees, `${pair.mechanism} absolute (°)`),
          ],
          unit: '°',
          from: worst.start - 3,
          to: worst.start + WINDOW_SECONDS + 3,
        },
      })
    }
    return problems
  },
})

/**
 * Each whole second while enabled when the motor moved past MOTOR_DEGREES, the absolute angle barely followed, and the
 * motor's gap to the mechanism changed by most of that travel from a second before to a second after.
 */
function slipSeconds(pair: SlipCheck, match: MatchView): { start: number; motor: number; absolute: number }[] {
  const motor = match.signal(pair.motor)
  const absolute = match.signal(pair.absolute)
  const motorDegrees = (t: number) => motor.at(t) * pair.motorToDegrees
  const absoluteDegrees = (t: number) => absolute.at(t) * pair.absoluteToDegrees
  const gap = (t: number) => motorDegrees(t) - absoluteDegrees(t)
  const out: { start: number; motor: number; absolute: number }[] = []
  for (const period of match.enabled) {
    for (let t = period.start; t + WINDOW_SECONDS <= period.end; t += WINDOW_SECONDS) {
      const end = t + WINDOW_SECONDS
      const motorTravel = Math.abs(motorDegrees(end) - motorDegrees(t))
      const absoluteTravel = Math.abs(absoluteDegrees(end) - absoluteDegrees(t))
      const gapChange = Math.abs(gap(end + WINDOW_SECONDS) - gap(t - WINDOW_SECONDS))
      const slipped = motorTravel > MOTOR_DEGREES && absoluteTravel < FOLLOWS_AT_LEAST * motorTravel
      if (!slipped || gapChange <= STILL_OFF_SHARE * motorTravel) continue
      out.push({ start: t, motor: motorTravel, absolute: absoluteTravel })
    }
  }
  return out
}
