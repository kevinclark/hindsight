/**
 * mech/follower-mismatch — do motors on one control loop spin at the same speed?
 *
 * Checks: for each `sameLoop` group (a leader and its followers), at steady speed (leader above 20 rot/s and within
 * 3 % of its speed 0.5 s earlier): each motor's median speed relative to the leader, and how long it ran more than
 * 15 % off. Fires when any motor was more than 15 % off for 1 s or more in the match.
 * Why: CalGames 2026 Q21: flywheel followers 17 and 18 dropped 25 % below the leader while shooting, at the same
 * commanded voltage. The velocity loop only sees the leader, so nothing corrected it. The same pattern is in Q13
 * and P0 (1.1–2.1 s per match); at steady speed overall 17 and 18 run 3–7 % slow.
 * When it fires: check belt tension, pulleys and set screws on the slow motors' shaft, and whether they share a
 * shaft or belt with the others.
 */
import { has, num, type Match } from '../../match/match.ts'
import { makeGrid, median, resample } from '../../match/series.ts'
import type { Finding, Rule } from '../types.ts'

const MIN_SPEED = 20
const STEADY = 0.03
const MISMATCH = 0.15
const MIN_SECONDS = 1
const DT = 0.02

export const followerMismatch: Rule = {
  id: 'mech/follower-mismatch',
  title: 'Motors on one loop at different speeds',
  audience: ['pit'],
  fix: 'Check belt tension, pulleys and set screws on the slow motor(s). If they drive a separate shaft, consider closing the loop on that shaft too.',
  incident: 'CalGames 2026 Q21: flywheel followers 17/18 ran 25 % slow while shooting (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 1)',
  needs: (m: Match) => m.profile.motorGroups.filter((g) => g.sameLoop).flatMap((g) => g.motors.map((x) => x.velocity ?? '')).filter(Boolean),
  run(m: Match): Finding[] {
    const out: Finding[] = []
    if (m.matchStart === null || m.matchEnd === null) return out
    const grid = makeGrid(m.matchStart, m.matchEnd, DT)
    for (const group of m.profile.motorGroups.filter((g) => g.sameLoop)) {
      const motors = group.motors.filter((x) => x.velocity && has(m, x.velocity))
      if (motors.length < 2) continue
      const speeds = motors.map((x) => resample(num(m, x.velocity!)!, grid).map(Math.abs))
      const lag = Math.round(0.5 / DT)
      const ratios: number[][] = motors.map(() => [])
      const steadyTimes: number[] = []
      for (let i = lag; i < grid.length; i++) {
        const lead = speeds[0][i]
        if (!(lead > MIN_SPEED) || Math.abs(lead - speeds[0][i - lag]) > STEADY * lead) continue
        steadyTimes.push(grid[i])
        motors.forEach((_, k) => ratios[k].push(speeds[k][i] / lead))
      }
      const offSeconds = ratios.map((r) => r.filter((x) => Math.abs(1 - x) > MISMATCH).length * DT)
      const worst = offSeconds.indexOf(Math.max(...offSeconds))
      if (offSeconds[worst] < MIN_SECONDS) continue
      const worstIndex = ratios[worst].reduce((w, x, i) => (Math.abs(1 - x) > Math.abs(1 - ratios[worst][w]) ? i : w), 0)
      const t = steadyTimes[worstIndex]
      out.push({
        rule: this.id,
        severity: 'warning',
        title: `${motors[worst].name} ran more than 15 % off ${motors[0].name} for ${offSeconds[worst].toFixed(1)} s at steady speed (median ${(100 * median(ratios[worst])).toFixed(0)} %)`,
        time: t,
        evidence: Object.fromEntries([
          ['steady seconds compared', +(steadyTimes.length * DT).toFixed(1)],
          ...motors.flatMap((x, k) => [[`${x.name}: median speed vs leader (%)`, +(100 * median(ratios[k])).toFixed(0)], [`${x.name}: seconds > 15 % off`, +offSeconds[k].toFixed(1)]]),
          [`${motors[worst].name} at its furthest (% of leader)`, +(100 * ratios[worst][worstIndex]).toFixed(0)],
        ]),
        plot: { from: t - 3, to: t + 3, unit: 'rot/s', lines: motors.map((x) => ({ label: x.name, key: x.velocity! })) },
      })
    }
    return out
  },
}
