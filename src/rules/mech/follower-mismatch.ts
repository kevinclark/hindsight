/**
 * mech/follower-mismatch — do motors on one control loop spin at the same speed?
 *
 * Checks: for each `sameLoop` group (a leader and its followers), at steady speed (leader above 20 rot/s and within
 * 3 % of its speed 0.5 s earlier), how long each motor ran more than 15 % off the leader. Fires when any motor
 * did for 1 s or more in the match.
 * Why: CalGames 2026 Q21: flywheel followers 17 and 18 ran 25 % slower than the leader and follower 16 while
 * shooting, at the same commanded voltage. The velocity loop only sees the leader, so nothing corrected it.
 * (The same pattern is in Q13 and P0: 1.1–2.1 s per match.)
 * When it fires: check belt tension, pulleys and set screws on the slow motors' shaft, and whether they share a
 * shaft or belt with the others.
 */
import { has, num, type Match } from '../../match/match.ts'
import { makeGrid, resample } from '../../match/series.ts'
import type { Finding, Rule } from '../types.ts'

const MIN_SPEED = 20
const STEADY = 0.03
const MISMATCH = 0.15
const MIN_SECONDS = 1
const DT = 0.02

export const followerMismatch: Rule = {
  id: 'mech/follower-mismatch',
  title: 'Motors on one loop at different speeds',
  fix: 'Check belt tension, pulleys and set screws on the slow motor(s). If they drive a separate shaft, consider closing the loop on that shaft too.',
  incident: 'CalGames 2026 Q21: flywheel followers 17/18 ran 25 % slow (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 1)',
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
      let steadySamples = 0
      const offSamples = motors.map(() => 0)
      const worstAt = motors.map(() => ({ off: 0, t: 0 }))
      for (let i = lag; i < grid.length; i++) {
        const lead = speeds[0][i]
        if (!(lead > MIN_SPEED) || Math.abs(lead - speeds[0][i - lag]) > STEADY * lead) continue
        steadySamples++
        motors.forEach((_, k) => {
          const off = Math.abs(1 - speeds[k][i] / lead)
          if (off > MISMATCH) offSamples[k]++
          if (off > worstAt[k].off) worstAt[k] = { off, t: grid[i] }
        })
      }
      const worst = offSamples.indexOf(Math.max(...offSamples))
      if (offSamples[worst] * DT < MIN_SECONDS) continue
      const t = worstAt[worst].t
      out.push({
        rule: this.id,
        severity: 'warning',
        title: `${motors[worst].name} ran more than 15 % off ${motors[0].name} for ${(offSamples[worst] * DT).toFixed(1)} s at steady speed`,
        time: t,
        evidence: Object.fromEntries([
          ['steady seconds compared', +(steadySamples * DT).toFixed(1)],
          ...motors.map((x, k) => [`${x.name}: seconds > 15 % off`, +(offSamples[k] * DT).toFixed(1)]),
          [`worst moment: ${motors[worst].name} vs leader (%)`, +(100 * (1 - worstAt[worst].off)).toFixed(0)],
        ]),
        plot: { from: t - 3, to: t + 3, unit: 'rot/s', lines: motors.map((x) => ({ label: x.name, key: x.velocity!, scale: 1 })) },
      })
    }
    return out
  },
}
