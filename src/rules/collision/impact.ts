/**
 * Did the robot take a hard hit?
 *
 * Checks: sideways acceleration from the gyro's accelerometer, √(ax² + ay²), above 3 g during the match.
 * Why: hits against field metal come before controller drops in #in-hindsight (≥ 8 episodes), and the Q13 trench hit
 * would have shown here had the accelerometer been logged then (it was added after Q13).
 * Threshold: assumed. Q21 and P0 peaked at 2.6 and 2.8 g with no known collision; backtest before trusting it.
 */
import { rule, round, type Problem } from '../rule.ts'

const LIMIT_G = 3

export default rule({
  id: 'collision/impact',
  title: 'Hard hit',
  severity: 'warning',
  who: ['pit', 'drive'],
  meaning: 'The robot took a hard sideways jolt. Hits like this can knock connectors, the radio or the battery loose, and cause dropouts afterwards.',
  causes: [
    { id: 'collision', cause: 'The robot hit a wall, field element or another robot', look: 'the match video at this time; the gyro acceleration plot in this finding' },
    { id: 'hard-stop', cause: 'A mechanism slammed into its hard stop, or the robot landed hard after a bump', look: 'mechanism positions in AdvantageScope at this time; was something moving fast just before?' },
    { id: 'sensor-spike', cause: 'A one-sample spike from the accelerometer, not a real hit', look: 'the plot: a single thin spike with no change in the robot\'s speed or heading is probably noise' },
  ],
  nextStep: 'Watch the video at this time. After the match, check connectors, the radio and the battery strap for anything knocked loose.',
  incident: '#in-hindsight: controller drops after touching field metal (≥ 8 episodes, hindsight-research/issue-catalog-slack.md)',

  check(match) {
    const trouble = (from: number, to: number) => [
      match.has('brownedOut') && match.signal('brownedOut').turnsOn(match.between(from, to)).length > 0 ? 'browned out' : '',
      match.has('commsDisableCount') && match.signal('commsDisableCount').increases(match.between(from, to)).length > 0 ? 'lost comms' : '',
    ].filter(Boolean)
    const grid = match.grid()
    const ax = match.signal('accelX').onGrid(grid)
    const ay = match.signal('accelY').onGrid(grid)
    const hits: { at: number; g: number }[] = []
    for (let i = 0; i < grid.length; i++) {
      const g = Math.hypot(ax[i], ay[i]) / 9.81
      const lastHit = hits[hits.length - 1]
      if (g > LIMIT_G && (!lastHit || grid[i] - lastHit.at > 1)) hits.push({ at: grid[i], g })
    }
    return hits.map((h): Problem => {
      // Did the robot brown out or lose comms in the 2 s after the hit? Then something was probably knocked loose.
      const after = trouble(h.at, h.at + 2)
      return {
      message: `${h.g.toFixed(1)} g hit at ${match.when(h.at)}`,
      at: h.at,
      evidence: { 'sideways acceleration (g)': round(h.g), 'threshold (g)': LIMIT_G },
      measured: [{ label: 'sideways acceleration', value: round(h.g), unit: 'g', threshold: LIMIT_G }],
      plot: { signals: ['accelX', 'accelY'], unit: 'm/s²', from: h.at - 2, to: h.at + 2 },
      nextStep: after.length ? `The robot ${after.join(' and ')} within 2 s of this hit: check the battery leads, the main breaker and the radio\'s power and Ethernet cables first.` : undefined,
      }
    })
  },
})
