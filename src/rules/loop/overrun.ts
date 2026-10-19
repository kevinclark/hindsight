/**
 * Is the robot code finishing each loop in 20 ms?
 *
 * Checks: the share of loops over 20 ms (/RealOutputs/LoggedRobot/FullCycleMS), the 99th percentile and the worst,
 * in auto and in teleop. Fires when either overruns on more than 10 % of loops.
 * Why: CalGames 2026: 14–27 % of auto loops overran (worst 134 ms). A 130 ms loop at 2.5 m/s is 0.33 m of blind
 * travel on a trench approach.
 */
import { maxOf } from '../../match/series.ts'
import { pct, rule, round } from '../rule.ts'

export default rule({
  id: 'loop/overrun',
  title: 'Loop overruns',
  severity: 'warning',
  who: ['software'],
  fix: 'Use the Tracer/* entries to find the slow step in auto (vision updates, path following, logging) and move it off the main loop or cache it.',
  incident: 'CalGames 2026: auto overran 14–27 % of loops, worst 134 ms (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 3)',

  check(match) {
    const loop = match.signal('loopCycleMs')
    const auto = loop.samples(match.auto)
    const teleop = loop.samples(match.teleop)
    const overShare = (xs: number[]) => (xs.length ? xs.filter((ms) => ms > 20).length / xs.length : 0)
    const [worstName, worst] = overShare(auto) >= overShare(teleop) ? ['auto', auto] : ['teleop', teleop]
    if (overShare(worst) <= 0.1) return
    return {
      message: `${pct(overShare(worst))} of ${worstName} loops took longer than 20 ms (worst ${maxOf(worst).toFixed(0)} ms)`,
      evidence: {
        'auto: share over 20 ms (%)': round(100 * overShare(auto), 1), 'auto: p99 (ms)': round(loop.percentile(99, match.auto), 0), 'auto: worst (ms)': round(maxOf(auto), 0),
        'teleop: share over 20 ms (%)': round(100 * overShare(teleop), 1), 'teleop: p99 (ms)': round(loop.percentile(99, match.teleop), 0), 'teleop: worst (ms)': round(maxOf(teleop), 0),
      },
      measured: [{ label: `${worstName} loops over 20 ms`, value: round(100 * overShare(worst), 1), unit: '%', threshold: 10 }],
      plot: [loop], plotUnit: 'ms', plotLine: { value: 20, label: '20 ms' },
      plotFrom: (worstName === 'auto' ? match.auto : match.teleop)[0]?.start, plotTo: (worstName === 'auto' ? match.auto : match.teleop)[0]?.end,
    }
  },
})
