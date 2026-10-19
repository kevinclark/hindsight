/**
 * Did the robot take a hard hit?
 *
 * Checks: sideways acceleration from the gyro's accelerometer, √(ax² + ay²), above 3 g during the match.
 * Why: hits against field metal come before controller drops in #in-hindsight (≥ 8 episodes), and the Q13 trench hit
 * would have shown here had the accelerometer been logged then (it was added after Q13).
 * Threshold: assumed. Q21 and P0 peaked at 2.6 and 2.8 g with no known collision; backtest before trusting it.
 */
import { rule, round } from '../rule.ts'

const LIMIT_G = 3

export default rule({
  id: 'collision/impact',
  title: 'Hard hit',
  severity: 'warning',
  who: ['pit', 'drive'],
  fix: 'Watch the video at this time. After the match, check connectors, the radio and the battery strap for anything knocked loose.',
  incident: '#in-hindsight: controller drops after touching field metal (≥ 8 episodes, hindsight-research/issue-catalog-slack.md)',

  check(match) {
    const grid = match.grid()
    const ax = match.signal('accelX').onGrid(grid)
    const ay = match.signal('accelY').onGrid(grid)
    const hits: { at: number; g: number }[] = []
    for (let i = 0; i < grid.length; i++) {
      const g = Math.hypot(ax[i], ay[i]) / 9.81
      const lastHit = hits[hits.length - 1]
      if (g > LIMIT_G && (!lastHit || grid[i] - lastHit.at > 1)) hits.push({ at: grid[i], g })
    }
    return hits.map((h) => ({
      message: `${h.g.toFixed(1)} g hit at ${match.when(h.at)}`,
      at: h.at,
      evidence: { 'sideways acceleration (g)': round(h.g), 'threshold (g)': LIMIT_G },
      plot: ['accelX', 'accelY'], plotUnit: 'm/s²', plotFrom: h.at - 2, plotTo: h.at + 2,
    }))
  },
})
