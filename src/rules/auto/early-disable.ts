/**
 * Was the robot disabled during auto with time left, on the field?
 *
 * Checks: on the field (FMS attached), an auto period that ends more than 1 s early while the DS is still attached.
 * That is a deliberate disable (an A-stop or the drive team), not a comms loss.
 * Why: CalGames 2026 Q13: the robot wedged under the trench and was disabled with 7.4 s of auto left.
 */
import { rule, round } from '../rule.ts'

export default rule({
  id: 'auto/early-disable',
  title: 'Disabled during auto',
  severity: 'error',
  who: ['software', 'drive'],
  fix: 'Ask the drive team why (A-stop?), then check what happened just before: collision/tilt, a mechanism out of position, a stuck path.',
  incident: 'CalGames 2026 Q13: disabled at 282.7 s with 7.4 s of auto left after the hood hit the trench (2026-10-17-calgames-q13-log-analysis.md §1)',

  check(match) {
    if (!match.onField || match.autoStart === null) return
    const attached = match.signal('dsAttached')
    const autoPeriods = match.auto.filter((a) => a.start >= match.autoStart! && a.start < match.autoStart! + match.profile.game.autoSeconds)
    const early = autoPeriods.filter((a) => match.timeLeft(a.end) > 1 && attached.at(a.end + 0.05) > 0.5)
    // The plot is a bonus: draw the gyro if the log has it, but don't let a missing gyro stop the rule.
    const gyro = match.has('gyroPitch') && match.has('gyroRoll')
      ? [match.signal('gyroPitch').times(180 / Math.PI, 'Pitch'), match.signal('gyroRoll').times(180 / Math.PI, 'Roll')] : []
    return early.map((a) => ({
      message: `Disabled in auto at ${a.end.toFixed(1)} s with ${match.timeLeft(a.end).toFixed(1)} s of auto left`,
      at: a.end,
      // Context only: how much auto was left when it was disabled ("× the line" would read as how bad it was).
      measured: [{ label: 'left in auto when disabled', value: round(match.timeLeft(a.end), 1), unit: 's' }],
      evidence: { 'auto enabled (s)': round(match.autoStart!), 'disabled (s)': round(a.end), 'auto time left (s)': round(match.timeLeft(a.end), 1), 'DS still attached': 'yes' },
      plot: gyro,
      plotUnit: '°', plotFrom: match.autoStart! - 1, plotTo: a.end + 4, plotMarks: [a.end],
    }))
  },
})
