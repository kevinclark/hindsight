/**
 * Did the robot take a hard hit?
 *
 * Checks: sideways acceleration from the gyro's accelerometer, √(ax² + ay²), above 3 g during the match.
 * Why: hits against field metal come before controller drops in #in-hindsight (≥ 8 episodes), and the Q13 trench hit
 * would have shown here had the accelerometer been logged then (it was added after Q13).
 * Threshold: assumed. Q21 and P0 peaked at 2.6 and 2.8 g with no known collision; backtest before trusting it.
 */
import { rule, round, type Problem } from '../rule.ts'
import type { MatchView } from '../view.ts'

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
    const grid = match.grid()
    const ax = match.signal('accelX').onGrid(grid)
    const ay = match.signal('accelY').onGrid(grid)
    const hits: { at: number; g: number }[] = []
    for (let i = 0; i < grid.length; i++) {
      const g = Math.hypot(ax[i], ay[i]) / 9.81
      const lastHit = hits[hits.length - 1]
      const isNewHit = !lastHit || grid[i] - lastHit.at > 1
      if (g > LIMIT_G && isNewHit) hits.push({ at: grid[i], g })
    }

    return hits.map((hit): Problem => {
      // Did the robot brown out or lose comms in the 2 s after the hit? Then something was probably knocked loose.
      const after = troubleBetween(match, hit.at, hit.at + 2)
      const nextStep = after.length > 0
        ? `The robot ${after.join(' and ')} within 2 s of this hit: check the battery leads, the main breaker and the radio\'s power and Ethernet cables first.`
        : undefined
      return {
        message: `${hit.g.toFixed(1)} g hit at ${match.when(hit.at)}`,
        at: hit.at,
        evidence: { 'sideways acceleration (g)': round(hit.g), 'threshold (g)': LIMIT_G },
        measured: [{ label: 'sideways acceleration', value: round(hit.g), unit: 'g', threshold: LIMIT_G }],
        plot: { signals: ['accelX', 'accelY'], unit: 'm/s²', from: hit.at - 2, to: hit.at + 2 },
        nextStep,
      }
    })
  },
})

/** What went wrong between two times: 'browned out' and/or 'lost comms' (each only if the log has that signal). */
function troubleBetween(match: MatchView, from: number, to: number): string[] {
  const window = match.between(from, to)
  const brownedOut = match.signalIfLogged('brownedOut')
  const commsDisables = match.signalIfLogged('commsDisableCount')
  const trouble: string[] = []
  if (brownedOut && brownedOut.turnsOn(window).length > 0) trouble.push('browned out')
  if (commsDisables && commsDisables.increases(window).length > 0) trouble.push('lost comms')
  return trouble
}
