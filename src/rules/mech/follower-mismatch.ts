/**
 * Do motors on one control loop spin at the same speed?
 *
 * Checks: for each motor group marked `sameLoop` (a leader and its followers), at steady speed (leader above
 * 20 rot/s and within 3 % of its speed 0.5 s earlier), how long each motor ran more than 15 % off the leader.
 * Fires when one did for 1 s or more.
 * A motor logged slower than 30 times a second (throttled telemetry) is compared only at its own records, each
 * counting for its typical gap: between records its held value is stale, and a spinning-up leader would make a stale
 * follower look slow.
 * Why: CalGames 2026 Q21: flywheel followers 17 and 18 dropped 25 % below the leader while shooting. It was a belt
 * slipping, fixed just before elims. The velocity loop only sees the leader, so nothing corrected it.
 */
import { indexAt, median } from '../../match/series.ts'
import { rule, round } from '../rule.ts'
import { SLOW_HZ, sampleRate } from '../view.ts'

const DT = 0.02 // compare every 20 ms

export default rule({
  id: 'mech/follower-mismatch',
  title: 'Motors on one loop at different speeds',
  severity: 'warning',
  who: ['pit'],
  meaning: 'A motor that should turn at the same speed as its leader ran slower for a while. Its speed was not holding, so the mechanism was delivering less than the code asked for.',
  causes: [
    { id: 'slip', cause: 'A belt or gear slipping, or a pulley loose on its shaft, all the time', look: 'the slow motor\'s belt tension, pulleys and set screws; spin it by hand with the leader disconnected' },
    { id: 'config', cause: 'The follower is set up wrong (not following the leader, wrong gear ratio or direction)', look: 'the code file that configures this group: the follow setting and ratio for that motor' },
    { id: 'loose', cause: 'Something loose that slips only sometimes (a set screw, key or coupling, or a belt that only slips under load)', look: 'the same parts, while the mechanism is loaded; the speed plot in this finding: dips with recovery' },
    { id: 'motor-fault', cause: 'That motor or its controller cutting out (current limit, brownout, CAN dropout)', look: 'the can/device-dropout and power/limit-not-applied findings for that motor; the Limits tab' },
  ],
  nextStep: 'Check belt tension, pulleys and set screws on the slow motor. If the motors drive separate shafts, consider closing the loop on each shaft.',
  incident: 'CalGames 2026 Q21: flywheel followers 17/18 ran 25 % slow while shooting, a slipping belt (2026-10-17-calgames-q13-log-analysis.md, "Other issues" item 1)',
  forEach: 'motorGroup',

  check(group, match) {
    if (!group.sameLoop) return
    const grid = match.grid(DT)
    const leader = group.motors[0].velocity().onGrid(grid)
    const halfSecondAgo = Math.round(0.5 / DT)

    // For each motor: its speed as a fraction of the leader's, at every steady moment (a slowly logged motor: only
    // just after its own records, each standing for its typical gap).
    const motors = group.motors.map((m) => {
      const velocity = m.velocity()
      const rate = sampleRate(velocity.series, match.enabled)
      const slow = !!rate && rate.fastHz < SLOW_HZ
      return { name: m.name, speed: velocity.onGrid(grid), recordTimes: velocity.series.t, slow, weight: slow ? 1 / rate!.typicalHz : DT, ratios: [] as number[], times: [] as number[] }
    })
    const fresh = (m: (typeof motors)[0], t: number) => !m.slow || t - m.recordTimes[indexAt(m.recordTimes, t)] < DT
    for (let i = halfSecondAgo; i < grid.length; i++) {
      const now = Math.abs(leader[i])
      const before = Math.abs(leader[i - halfSecondAgo])
      const steady = now > 20 && Math.abs(now - before) <= 0.03 * now
      if (!steady) continue
      for (const m of motors) {
        if (!fresh(m, grid[i])) continue
        m.ratios.push(Math.abs(m.speed[i]) / now)
        m.times.push(grid[i])
      }
    }

    // The motor that spent longest more than 15 % off the leader, and its furthest moment.
    let worst = { name: '', secondsOff: 0, steadyShare: 0, median: 1, furthest: 1, at: 0 }
    for (const m of motors) {
      const secondsOff = m.ratios.filter((r) => Math.abs(1 - r) > 0.15).length * m.weight
      if (secondsOff <= worst.secondsOff) continue
      let furthest = 0
      for (let k = 1; k < m.ratios.length; k++) if (Math.abs(1 - m.ratios[k]) > Math.abs(1 - m.ratios[furthest])) furthest = k
      worst = { name: m.name, secondsOff, steadyShare: secondsOff / (m.ratios.length * m.weight), median: median(m.ratios), furthest: m.ratios[furthest], at: m.times[furthest] }
    }
    if (worst.secondsOff < 1) return

    const evidence: Record<string, number> = { 'steady seconds compared': round(motors[0].ratios.length * motors[0].weight, 1) }
    for (const m of motors) {
      evidence[`${m.name}: median speed vs leader (%)`] = round(100 * median(m.ratios), 0)
      evidence[`${m.name}: seconds > 15 % off`] = round(m.ratios.filter((r) => Math.abs(1 - r) > 0.15).length * m.weight, 1)
    }
    evidence[`${worst.name}: share of steady time > 15 % off (%)`] = round(100 * worst.steadyShare, 0)
    evidence[`${worst.name} at its furthest (% of leader)`] = round(100 * worst.furthest, 0)
    // Off for most of the steady time: a constant offset, so slip or a wrong setup. Off only now and then: something loose.
    const constant = worst.steadyShare > 0.5
    return {
      likely: constant ? ['slip', 'config'] : ['loose', 'motor-fault'],
      message: `${worst.name} ran more than 15 % off ${motors[0].name} for ${worst.secondsOff.toFixed(1)} s at steady speed (median ${(100 * worst.median).toFixed(0)} %)`,
      at: worst.at,
      evidence,
      measured: [
        { label: `${worst.name}: seconds more than 15 % off`, value: round(worst.secondsOff, 1), unit: 's', threshold: 1 },
        { label: `${worst.name}: median speed vs leader`, value: round(100 * worst.median, 0), unit: '%' },
      ],
      plot: group.motors.map((m) => m.velocity()), plotUnit: 'rot/s',
    }
  },
})
