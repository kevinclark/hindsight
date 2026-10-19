/**
 * loop/overrun — is the robot code finishing each cycle in 20 ms?
 *
 * Checks: /RealOutputs/LoggedRobot/FullCycleMS over 20 ms, as a share of cycles, p99 and max, in auto and teleop.
 * Fires when either phase overruns on more than 10 % of cycles.
 * Why: CalGames 2026: 14–27 % of auto cycles overran (max 134 ms). A 130 ms cycle at 2.5 m/s is 0.33 m of blind
 * travel on a trench approach.
 * When it fires: profile auto (Tracer/* entries show where the time goes): path generation, vision, logging.
 */
import { num, type Match } from '../../match/match.ts'
import { maxOf, percentile, type Interval } from '../../match/series.ts'
import type { Finding, Rule } from '../types.ts'

const PERIOD_MS = 20
const SHARE = 0.1

export const overrun: Rule = {
  id: 'loop/overrun',
  title: 'Loop overruns',
  audience: ['software'],
  fix: 'Use the Tracer/* entries to find the slow step in auto (vision updates, path following, logging) and move it off the main loop or cache it.',
  incident: 'CalGames 2026: auto overran 14–27 % of cycles, max 134 ms (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 3)',
  needs: (m: Match) => [m.profile.signals.loopCycleMs],
  run(m: Match): Finding[] {
    const s = num(m, m.profile.signals.loopCycleMs)!
    const stats = (ivs: Interval[]) => {
      const xs: number[] = []
      for (let i = 0; i < s.t.length; i++) if (ivs.some((iv) => s.t[i] >= iv.start && s.t[i] < iv.end)) xs.push(s.v[i])
      const over = xs.filter((x) => x > PERIOD_MS).length
      return { n: xs.length, share: xs.length ? over / xs.length : 0, p99: percentile(xs, 99), max: maxOf(xs) }
    }
    const auto = stats(m.auto)
    const teleop = stats(m.teleop)
    const worst = auto.share >= teleop.share ? { phase: 'auto', ...auto } : { phase: 'teleop', ...teleop }
    if (worst.share <= SHARE) return []
    return [{
      rule: this.id,
      severity: 'warning',
      title: `${(100 * worst.share).toFixed(0)} % of ${worst.phase} cycles took longer than 20 ms (max ${worst.max.toFixed(0)} ms)`,
      time: null,
      evidence: {
        'auto: share over 20 ms (%)': +(100 * auto.share).toFixed(1), 'auto: p99 (ms)': +auto.p99.toFixed(0), 'auto: max (ms)': +auto.max.toFixed(0),
        'teleop: share over 20 ms (%)': +(100 * teleop.share).toFixed(1), 'teleop: p99 (ms)': +teleop.p99.toFixed(0), 'teleop: max (ms)': +teleop.max.toFixed(0),
      },
      plot: m.auto[0] ? {
        from: m.auto[0].start, to: m.auto[0].end, unit: 'ms',
        lines: [{ label: 'Loop cycle', key: m.profile.signals.loopCycleMs }],
        threshold: { value: PERIOD_MS, label: '20 ms' },
      } : undefined,
    }]
  },
}
