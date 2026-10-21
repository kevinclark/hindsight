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
import { median, round, rule } from '../rule.ts'
import { FOLLOWER_LINE_SECONDS, mostOffLeader, secondsOffLeader, traceGroup } from './follower-trace.ts'

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
    // The trace code is shared with the Session view's Trends (follower-trace.ts).
    const motors = traceGroup(group, match)

    const worst = mostOffLeader(motors)
    if (worst.secondsOff < FOLLOWER_LINE_SECONDS) return

    const steadySeconds = motors[0].ratios.length * motors[0].weight
    const evidence: Record<string, number> = { 'steady seconds compared': round(steadySeconds, 1) }
    for (const m of motors) {
      evidence[`${m.name}: median speed vs leader (%)`] = round(100 * median(m.ratios), 0)
      evidence[`${m.name}: seconds > 15 % off`] = round(secondsOffLeader(m), 1)
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
        { label: `${worst.name}: seconds more than 15 % off`, value: round(worst.secondsOff, 1), unit: 's', threshold: FOLLOWER_LINE_SECONDS },
        { label: `${worst.name}: median speed vs leader`, value: round(100 * worst.median, 0), unit: '%' },
      ],
      plot: { signals: group.motors.map((m) => m.velocity()), unit: 'rot/s' },
    }
  },
})
