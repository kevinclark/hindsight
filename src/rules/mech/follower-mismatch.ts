/**
 * Do motors on one control loop spin at the same speed?
 *
 * Checks: for each motor group marked `sameLoop` (a leader and its followers), two things.
 * 1. At steady speed (leader above 20 rot/s and within 3 % of its speed 0.5 s earlier), how long each motor ran more
 *    than 15 % off the leader. Fires when one did for 1 s or more.
 * 2. Whenever the robot was enabled and the leader ran above 20 rot/s, steady or not, how long each follower ran
 *    under 20 % of the leader's speed (a follower that isn't turning). Fires at 2 s or more, when check 1 didn't.
 * A motor logged slower than 30 times a second (throttled telemetry) is compared only at its own records, each
 * counting for its typical gap: between records its held value is stale, and a spinning-up leader would make a stale
 * follower look slow.
 * Why: One 2026 match: flywheel followers 17 and 18 dropped 25 % below the leader while shooting. It was a belt
 * slipping, fixed just before elims. The velocity loop only sees the leader, so nothing corrected it.
 * Two 2026 practice logs: a follower was powered but not turning (about 3 % of the leader's speed for 9.9 s and 4.2 s)
 * while the leader's own loop swung 30 to 55 rot/s, so it never held steady and check 1 had nothing to compare.
 */
import { median, round, rule, secs, type Problem } from '../rule.ts'
import { CTRE_FOLLOWER_API } from '../sources.ts'
import {
  FOLLOWER_LINE_SECONDS, LEADER_RUNNING, MIN_STEADY_SECONDS, STOPPED_FRACTION, STOPPED_LINE_SECONDS,
  mostOffLeader, mostStoppedFollower, secondsOffLeader, traceGroup, type StoppedFollower,
} from './follower-trace.ts'
import type { GroupView } from '../view.ts'

export default rule({
  id: 'mech/follower-mismatch',
  title: 'Motors on one loop at different speeds',
  severity: 'warning',
  judges: 'performance',
  who: ['pit'],
  meaning: 'A motor that should turn at the same speed as its leader ran slower for a while, or did not turn at all. The mechanism was delivering less than the code asked for.',
  causes: [
    { id: 'slip', cause: 'A belt or gear slipping, or a pulley loose on its shaft, all the time', look: 'the slow motor\'s belt tension, pulleys and set screws; spin it by hand with the leader disconnected' },
    { id: 'config', cause: 'The follower is set up wrong (not following the leader, wrong gear ratio or direction)', look: 'the code file that configures this group: the follow setting and ratio for that motor' },
    { id: 'loose', cause: 'Something loose that slips only sometimes (a set screw, key or coupling, or a belt that only slips under load)', look: 'the same parts, while the mechanism is loaded; the speed plot in this finding: dips with recovery' },
    { id: 'motor-fault', cause: 'That motor or its controller cutting out (current limit, brownout, CAN dropout)', look: 'the can/device-dropout and power/limit-not-applied findings for that motor; the Limits tab' },
    { id: 'stopped', cause: 'The follower isn\'t turning with the mechanism: its belt or pulley is off, it\'s held, or it isn\'t following the leader (follow setting, wrong leader ID)', look: 'spin the mechanism by hand: does the follower turn with it? Then the code file that configures this group: the follow setting and the leader ID for that motor' },
  ],
  nextStep: 'Check belt tension, pulleys and set screws on the slow motor. If the motors drive separate shafts, consider closing the loop on each shaft.',
  incident: 'One 2026 match: flywheel followers 17/18 ran 25 % slow while shooting, a slipping belt',
  sources: [
    { ...CTRE_FOLLOWER_API, says: 'A Follower control request makes a Talon mirror another Talon\'s output: torque, duty cycle or voltage, in the leader\'s mode.' },
  ],
  thresholds: [
    { name: 'off the leader', value: 'more than 15 %', basis: 'judgment', how: 'Chosen. The one case seen ran 25 % slow (a slipping belt).' },
    { name: 'time off the leader', value: '1 s or more', basis: 'judgment', how: 'Chosen.' },
    { name: 'steady speed', value: 'leader above 20 rot/s and within 3 % of its speed 0.5 s earlier', basis: 'judgment', how: 'Chosen.' },
    { name: 'follower stopped', value: 'under 20 % of the leader\'s speed, with the leader above 20 rot/s (steady or not)', basis: 'measured', how: 'Library backtest, 646 same-loop group-logs: a stopped follower read 2.7–9.9 s (three logs; one was a CAN dropout); the most any healthy follower spent under 20 % was 0.6 s.' },
    { name: 'time stopped', value: '2 s or more', basis: 'measured', how: 'Library backtest, 646 same-loop group-logs: a stopped follower read 2.7–9.9 s (three logs; one was a CAN dropout); the most any healthy follower spent under 20 % was 0.6 s.' },
  ],
  forEach: 'motorGroup',

  // Only a group whose followers copy the leader's output should spin at the leader's speed.
  only: (group) => group.sameLoop,
  check(group, match) {
    // The trace code is shared with the Session view's Trends (follower-trace.ts).
    const motors = traceGroup(group, match)

    const worst = mostOffLeader(motors)
    const steadySeconds = motors[0].ratios.length * motors[0].weight

    // A follower that isn't turning at all is judged without the steadiness test: its leader's own loop may swing.
    const stopped = mostStoppedFollower(group, match)
    if (worst.secondsOff < FOLLOWER_LINE_SECONDS && stopped && stopped.seconds >= STOPPED_LINE_SECONDS) {
      return stoppedFinding(group, stopped)
    }

    // The leader never held a steady speed for long: the followers weren't compared, so this match says nothing.
    if (steadySeconds < MIN_STEADY_SECONDS && worst.secondsOff < FOLLOWER_LINE_SECONDS) {
      const held = secs(steadySeconds)
      return match.couldNotCheck(`the leader held a steady speed for only ${held} (needs ${MIN_STEADY_SECONDS} s)`)
    }
    if (worst.secondsOff < FOLLOWER_LINE_SECONDS) return

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

/** The finding for a follower that ran under 20 % of its leader's speed for 2 s or more, dated at its first stopped moment. */
function stoppedFinding(group: GroupView, stopped: StoppedFollower): Problem {
  const leader = group.motors[0].name
  const percent = round(100 * stopped.medianRatio, 0)
  const line = 100 * STOPPED_FRACTION
  const secondsLabel = `${stopped.name}: seconds under ${line} % of the leader`
  return {
    likely: ['stopped', 'motor-fault'],
    message: `${stopped.name} ran under ${line} % of ${leader}'s speed for ${stopped.seconds.toFixed(1)} s `
      + `while the leader ran above ${LEADER_RUNNING} rot/s`,
    at: stopped.at,
    evidence: {
      'stopped follower': stopped.name,
      'stopped until (s)': round(stopped.until, 1),
      [secondsLabel]: round(stopped.seconds, 1),
      [`${stopped.name}: median speed vs leader while stopped (%)`]: percent,
    },
    measured: [
      { label: secondsLabel, value: round(stopped.seconds, 1), unit: 's', threshold: STOPPED_LINE_SECONDS },
      { label: `${stopped.name}: median speed vs leader while stopped`, value: percent, unit: '%' },
    ],
    plot: { signals: group.motors.map((m) => m.velocity()), unit: 'rot/s' },
  }
}
