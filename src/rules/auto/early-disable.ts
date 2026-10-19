/**
 * Was the robot disabled during auto with time left, on the field?
 *
 * Checks: on the field (FMS attached), an auto period that ends more than 1 s early while the DS is still attached.
 * That is a deliberate disable (an A-stop or the drive team), not a comms loss.
 * Why: CalGames 2026 Q13: the robot wedged under the trench and was disabled with 7.4 s of auto left.
 */
import { rule, round, type Problem } from '../rule.ts'

const TILTED_DEGREES = 15 // the same line as collision/tilt

export default rule({
  id: 'auto/early-disable',
  title: 'Disabled during auto',
  severity: 'error',
  who: ['software', 'drive'],
  meaning: 'The robot was disabled partway through auto while the Driver Station was still connected, so a person or the field turned it off on purpose. It was not a comms loss.',
  causes: [
    { id: 'a-stop', cause: 'The drive team pressed A-stop or disabled it because the robot was stuck, headed somewhere wrong or unsafe', look: 'ask the drive team what they saw; the match video at this time' },
    { id: 'wedged', cause: 'The robot hit or wedged on a field element (it tilted, then stopped)', look: 'Match tab: pitch and roll just before the disable; the collision/tilt finding for this match' },
    { id: 'mechanism', cause: 'A mechanism was out of position (a failed zero, a stuck arm or intake)', look: 'the mech/zero-not-completed finding; the mechanism\'s position in AdvantageScope just before the disable' },
    { id: 'field', cause: 'The field or a referee disabled the robot', look: 'ask the head referee or FTA why; the field log for this match' },
  ],
  nextStep: 'Ask the drive team why they disabled it, then check what happened in the seconds before: tilt, a mechanism out of position, a stuck path.',
  incident: 'CalGames 2026 Q13: disabled at 282.7 s with 7.4 s of auto left after the hood hit the trench (2026-10-17-calgames-q13-log-analysis.md §1)',

  check(match) {
    if (!match.onField || match.autoStart === null) return
    const attached = match.signal('dsAttached')
    const autoPeriods = match.auto.filter((a) => a.start >= match.autoStart! && a.start < match.autoStart! + match.profile.game.autoSeconds)
    const early = autoPeriods.filter((a) => match.timeLeft(a.end) > 1 && attached.at(a.end + 0.05) > 0.5)
    // The plot is a bonus: draw the gyro if the log has it, but don't let a missing gyro stop the rule.
    const gyro = match.has('gyroPitch') && match.has('gyroRoll')
      ? [match.signal('gyroPitch').times(180 / Math.PI, 'Pitch'), match.signal('gyroRoll').times(180 / Math.PI, 'Roll')] : []
    return early.map((a): Problem => {
      // How far did it tilt in the 3 s before the disable? Past the collision/tilt line, it probably hit something.
      const lastSeconds = match.before(a.end, 3)
      const tilt = Math.max(0, ...gyro.map((axis) => Math.max(Math.abs(axis.lowest(lastSeconds).value), Math.abs(axis.highest(lastSeconds).value))))
      const wedged = tilt > TILTED_DEGREES
      return {
        // The last instant of auto: at a.end itself the robot already reads as disabled.
        message: `Disabled in auto at ${match.when(a.end - 0.001)} with ${match.timeLeft(a.end).toFixed(1)} s of auto left`,
        at: a.end - 0.001,
        likely: wedged ? ['wedged'] : undefined,
        nextStep: wedged ? `The robot tilted ${tilt.toFixed(0)}° in the 3 s before the disable: watch the video for what it hit, and add a guard in code near that spot.` : undefined,
        // Context only: how much auto was left when it was disabled ("× the line" would read as how bad it was).
        measured: [{ label: 'left in auto when disabled', value: round(match.timeLeft(a.end), 1), unit: 's' }],
        evidence: { 'auto enabled (robot time, s)': round(match.autoStart!), 'disabled (robot time, s)': round(a.end), 'auto time left (s)': round(match.timeLeft(a.end), 1), 'DS still attached': 'yes' },
        plot: gyro,
        plotUnit: '°', plotFrom: match.autoStart! - 1, plotTo: a.end + 4, plotMarks: [a.end],
      }
    })
  },
})
