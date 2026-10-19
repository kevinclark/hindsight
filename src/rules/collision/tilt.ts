/**
 * Did the robot tip or wedge?
 *
 * Checks: gyro pitch or roll beyond ±15° for longer than 0.3 s while enabled. Red in auto, amber in teleop.
 * Bump crossings tilt past 15° too, but for 0.2 s or less (every CalGames log has several). The margin is thin:
 * 0.3 s is 1.5× the longest bump and 2.7× under the one wedge we have (0.82 s). Backtest before changing it.
 * Why: CalGames 2026 Q13: the hood hit the trench bar in auto, pitch −24° for 0.8 s, and the robot was disabled.
 * Not yet: field bump and trench zones (the game pack, phase 2).
 */
import { beyond, rule, round, type Problem } from '../rule.ts'

export default rule({
  id: 'collision/tilt',
  title: 'Robot tilted or wedged',
  severity: 'warning',
  who: ['software', 'pit', 'drive'],
  fix: 'Watch the match video at this time. If it was a field element, check what was raised (hood, intake) and add a guard in code near that element.',
  incident: 'CalGames 2026 Q13: −24° pitch for 0.8 s at the trench in auto (2026-10-17-calgames-q13-log-analysis.md §1)',

  check(match) {
    const problems: Problem[] = []
    const pitch = match.signal('gyroPitch').times(180 / Math.PI, 'Pitch')
    const roll = match.signal('gyroRoll').times(180 / Math.PI, 'Roll')
    for (const axis of [pitch, roll]) {
      for (const e of axis.episodes(beyond(15), { during: match.enabled, longerThan: 0.3 })) {
        const angle = Math.abs(e.lowest) > Math.abs(e.highest) ? e.lowest : e.highest
        const phase = match.phaseAt(e.start)
        problems.push({
          message: `${axis.label} ${angle.toFixed(0)}° for ${e.seconds.toFixed(1)} s at ${match.when(e.start)}`,
          at: e.start,
          about: axis.label,
          severity: phase === 'auto' ? 'error' : 'warning',
          evidence: { axis: axis.label, 'peak (°)': round(angle, 1), 'seconds beyond ±15°': round(e.seconds), phase },
          plot: [pitch, roll], plotUnit: '°', plotFrom: e.start - 3, plotTo: e.end + 3,
        })
      }
    }
    return problems
  },
})
