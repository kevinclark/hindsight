/**
 * Do motors on one control loop spin at the same speed?
 *
 * Checks: for each motor group marked `sameLoop` (a leader and its followers), at steady speed (leader above
 * 20 rot/s and within 3 % of its speed 0.5 s earlier), how long each motor ran more than 15 % off the leader.
 * Fires when one did for 1 s or more.
 * Why: CalGames 2026 Q21: flywheel followers 17 and 18 dropped 25 % below the leader while shooting. It was a belt
 * slipping, fixed just before elims. The velocity loop only sees the leader, so nothing corrected it.
 */
import { median } from '../../match/series.ts'
import { rule, round } from '../rule.ts'

const DT = 0.02

export default rule({
  id: 'mech/follower-mismatch',
  title: 'Motors on one loop at different speeds',
  severity: 'warning',
  who: ['pit'],
  fix: 'Check belt tension, pulleys and set screws on the slow motor(s). If they drive a separate shaft, consider closing the loop on that shaft too.',
  incident: 'CalGames 2026 Q21: flywheel followers 17/18 ran 25 % slow while shooting, a slipping belt (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 1)',
  forEach: 'motorGroup',

  check(group, match) {
    if (!group.sameLoop) return
    const grid = match.grid(DT)
    const speeds = group.motors.map((m) => m.velocity().onGrid(grid).map(Math.abs))
    const leader = speeds[0]
    const halfSecond = Math.round(0.5 / DT)
    const ratios: number[][] = group.motors.map(() => [])
    const times: number[] = []
    for (let i = halfSecond; i < grid.length; i++) {
      const steady = leader[i] > 20 && Math.abs(leader[i] - leader[i - halfSecond]) <= 0.03 * leader[i]
      if (!steady) continue
      times.push(grid[i])
      speeds.forEach((s, k) => ratios[k].push(s[i] / leader[i]))
    }
    const secondsOff = ratios.map((r) => r.filter((x) => Math.abs(1 - x) > 0.15).length * DT)
    const worst = secondsOff.indexOf(Math.max(...secondsOff))
    if (secondsOff[worst] < 1) return
    const furthest = ratios[worst].reduce((w, x, i) => (Math.abs(1 - x) > Math.abs(1 - ratios[worst][w]) ? i : w), 0)
    return {
      message: `${group.motors[worst].name} ran more than 15 % off ${group.motors[0].name} for ${secondsOff[worst].toFixed(1)} s at steady speed (median ${(100 * median(ratios[worst])).toFixed(0)} %)`,
      at: times[furthest],
      evidence: Object.fromEntries([
        ['steady seconds compared', round(times.length * DT, 1)],
        ...group.motors.map((m, k) => [`${m.name}: median speed vs leader (%)`, round(100 * median(ratios[k]), 0)]),
        ...group.motors.map((m, k) => [`${m.name}: seconds > 15 % off`, round(secondsOff[k], 1)]),
      ]),
      plot: group.motors.map((m) => m.velocity()), plotUnit: 'rot/s',
    }
  },
})
