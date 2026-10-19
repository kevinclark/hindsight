/**
 * collision/impact — did the robot take a hard hit?
 *
 * Checks: horizontal acceleration from the gyro's accelerometer (√(ax² + ay²)) above 3 g while enabled.
 * Why: hits against field metal precede controller drops in #in-hindsight (≥ 8 episodes), and the Q13 trench hit
 * would have shown here had the accelerometer been logged then (it was added after Q13).
 * Threshold: assumed. CalGames Q21 and P0 peaked at 2.6 and 2.8 g with no known collision; backtest before trusting.
 * When it fires: watch the video at that time and check the robot for loose parts, connectors and the radio.
 */
import { num, type Match } from '../../match/match.ts'
import { makeGrid, resample } from '../../match/series.ts'
import { when } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

const G = 9.81
const LIMIT_G = 3

export const impact: Rule = {
  id: 'collision/impact',
  title: 'Hard hit',
  fix: 'Watch the video at this time. After the match, check connectors, the radio and the battery strap for anything knocked loose.',
  incident: '#in-hindsight: controller drops after touching field metal (≥ 8 episodes, hindsight-research/issue-catalog-slack.md)',
  needs: (m: Match) => [m.profile.signals.accelX, m.profile.signals.accelY],
  run(m: Match): Finding[] {
    if (m.matchStart === null || m.matchEnd === null) return []
    const grid = makeGrid(m.matchStart, m.matchEnd, 0.02)
    const ax = resample(num(m, m.profile.signals.accelX)!, grid)
    const ay = resample(num(m, m.profile.signals.accelY)!, grid)
    const hits: { t: number; g: number }[] = []
    for (let i = 0; i < grid.length; i++) {
      const g = Math.hypot(ax[i], ay[i]) / G
      if (g > LIMIT_G && (hits.length === 0 || grid[i] - hits[hits.length - 1].t > 1)) hits.push({ t: grid[i], g })
    }
    return hits.map((h) => ({
      rule: this.id,
      severity: 'warning' as const,
      title: `${h.g.toFixed(1)} g hit at ${when(m, h.t)}`,
      time: h.t,
      evidence: { 'horizontal acceleration (g)': +h.g.toFixed(2), 'threshold (g)': LIMIT_G },
      plot: {
        from: h.t - 2, to: h.t + 2, unit: 'm/s²',
        lines: [{ label: 'Accel X', key: m.profile.signals.accelX }, { label: 'Accel Y', key: m.profile.signals.accelY }],
      },
    }))
  },
}
