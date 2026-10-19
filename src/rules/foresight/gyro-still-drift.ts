/**
 * How far did the gyro's heading drift while the robot sat still?
 *
 * Checks (Foresight, the live pit check, only): the change in gyro yaw over the last 20 s of the disabled stretch.
 * It is context, not a verdict: there is no line yet.
 * Measured on the CalGames field logs, disabled: 0.005–0.044° per 20 s just before enable, but 0.3–4.4° per 20 s in
 * the first one to two minutes after boot (Q21 stayed above 0.25° for about 100 s). A gyro that is still settling,
 * or a robot being handled, both show up here; nothing tells them apart yet.
 */
import { rule, round } from '../rule.ts'

const STILL_SECONDS = 20

export default rule({
  id: 'foresight/gyro-still-drift',
  title: 'Gyro drift while still',
  severity: 'info',
  who: ['software', 'pit'],
  meaning: 'How much the robot\'s heading changed while it sat disabled. A gyro that drifts while still makes field-relative driving and auto paths slowly turn.',
  causes: [
    { id: 'settling', cause: 'The gyro is still settling after power-on (normal for the first minute or two)', look: 'how long since the robot was powered on; watch whether the number falls' },
    { id: 'handled', cause: 'Someone is moving or bumping the robot', look: 'is anyone touching the robot or the cart?' },
    { id: 'gyro', cause: 'A loose or faulty gyro (Pigeon), or one mounted where it vibrates', look: 'the Pigeon\'s mounting and CAN connector; Phoenix Tuner X faults' },
  ],
  nextStep: 'Leave the robot untouched for 20 s and watch the number; if it stays high long after power-on, check the gyro\'s mounting and connector.',
  incident: 'CalGames 2026 Q21: 0.49° per 20 s early in the disabled stretch (foresight-proposal.md)',

  check(match) {
    const stretch = match.beforeEnable.at(-1)
    if (!stretch) return // a match log: this is a pit check
    const fp = match.profile.foresight
    if (!fp) return match.couldNotCheck('the robot profile does not name the gyro')
    if (stretch.end - stretch.start < STILL_SECONDS - 0.01) return match.couldNotCheck(`less than ${STILL_SECONDS} s to measure over yet`)
    const yaw = match.signal(fp.gyroYaw).times(180 / Math.PI, 'gyro yaw (°)')
    // Never before the stretch starts (a rounding hair before it reads as "no value yet").
    const from = Math.max(stretch.start, stretch.end - STILL_SECONDS)
    let moved = yaw.at(stretch.end) - yaw.at(from)
    if (!Number.isFinite(moved)) return match.couldNotCheck('the gyro sent no heading in the last 20 s')
    moved -= 360 * Math.round(moved / 360) // across ±180°
    return {
      message: `Gyro heading moved ${Math.abs(moved).toFixed(2)}° in the last ${STILL_SECONDS} s with the robot disabled`,
      at: stretch.end,
      measured: [{ label: `yaw change in ${STILL_SECONDS} s`, value: round(Math.abs(moved), 3), unit: '°' }],
      evidence: {
        [`yaw change in the last ${STILL_SECONDS} s (°)`]: round(moved, 3),
        'CalGames, disabled on the field (°)': '0.005–0.044 before enable; 0.3–4.4 in the first 1–2 min after boot',
      },
      plot: [yaw], plotUnit: '°', plotFrom: stretch.end - STILL_SECONDS, plotTo: stretch.end,
    }
  },
})
