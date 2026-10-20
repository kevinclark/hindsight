/**
 * Did the robot tip or wedge?
 *
 * Checks: gyro pitch or roll beyond ±15° for longer than 0.3 s while enabled. Red in auto, amber in teleop.
 * Bump crossings tilt past 15° too, but for 0.2 s or less (every CalGames log has several). The margin is thin:
 * 0.3 s is 1.5× the longest bump and 2.7× under the one wedge we have (0.82 s). Backtest before changing it.
 * Why: CalGames 2026 Q13: the hood hit the trench bar in auto, pitch −24° for 0.8 s, and the robot was disabled.
 * Not yet: field bump and trench zones (the game pack, phase 2).
 */
import { beyond, rule, round, secs, type Problem } from '../rule.ts'

export default rule({
  id: 'collision/tilt',
  title: 'Robot tilted or wedged',
  severity: 'warning',
  who: ['software', 'pit', 'drive'],
  meaning: 'The robot tipped or tilted past 15° for a while. Usually it drove onto or into something and got wedged; in auto that can cost the match.',
  causes: [
    { id: 'field-element', cause: 'The robot drove into or onto a field element (bump, ramp, bar) and wedged', look: 'the match video at this time; where the robot was on the field (Match tab)' },
    { id: 'raised-mechanism', cause: 'A raised mechanism (arm, intake) caught on something', look: 'mechanism positions in AdvantageScope at this time; was something extended or not yet zeroed?' },
    { id: 'tipping', cause: 'The robot tipped from driving or turning too hard', look: 'driver inputs and speed just before; how high the heavy parts sit' },
    { id: 'gyro', cause: 'The gyro is mounted tilted or reads wrong', look: 'the pitch and roll plot at rest before the match: should be near 0°' },
  ],
  nextStep: 'Watch the match video at this time. If it was a field element, check what was raised and add a guard in code near that element.',
  incident: 'CalGames 2026 Q13: −24° pitch for 0.8 s at the trench in auto (2026-10-17-calgames-q13-log-analysis.md §1)',

  check(match) {
    const pitch = match.signal('gyroPitch').inDegrees('Pitch')
    const roll = match.signal('gyroRoll').inDegrees('Roll')
    const problems: Problem[] = []
    for (const axis of [pitch, roll]) {
      for (const e of axis.episodes(beyond(15), { during: match.enabled, longerThan: 0.3 })) {
        const angle = Math.abs(e.lowest) > Math.abs(e.highest) ? e.lowest : e.highest
        const phase = match.phaseAt(e.start)
        // In auto the path drives itself, so a wedge there points at the path and what was raised.
        let nextStep: string | undefined
        if (phase === 'auto') {
          nextStep = 'It tilted during auto, so the auto path drove into something: watch the video, and check the path near this spot and what was raised.'
        }
        problems.push({
          message: `${axis.label} ${angle.toFixed(0)}° for ${secs(e.seconds)} at ${match.when(e.start)}`,
          at: e.start,
          about: axis.label,
          severity: phase === 'auto' ? 'error' : 'warning',
          measured: [{ label: axis.label.toLowerCase(), value: round(Math.abs(angle), 1), unit: '°', threshold: 15 }],
          evidence: { axis: axis.label, 'peak (°)': round(angle, 1), 'seconds beyond ±15°': round(e.seconds), phase },
          plot: { signals: [pitch, roll], unit: '°', from: e.start - 3, to: e.end + 3 },
          nextStep,
        })
      }
    }
    return problems
  },
})
