/**
 * How long each motor of a leader-and-followers group ran more than 15 % off the leader, at steady speed. One
 * definition for mech/follower-mismatch (which fires on it) and for the Session view's Trends (which plots it), so
 * the chart can never disagree with the rule.
 *
 * Steady: the leader above 20 rot/s and within 3 % of its speed 0.5 s earlier, compared every 20 ms.
 * A motor logged slower than 30 times a second (throttled telemetry) is compared only at its own records, each
 * counting for its typical gap: between records its held value is stale, and a spinning-up leader would make a stale
 * follower look slow.
 */
import { indexAt } from '../../match/series.ts'
import { median } from '../rule.ts'
import { MissingSignal, SLOW_HZ, sampleRate, type GroupView, type MatchView, type MotorView } from '../view.ts'

export const FOLLOWER_DT = 0.02 // compare every 20 ms
/** A motor this far (as a fraction of the leader's speed) from the leader is "off". */
export const OFF_FRACTION = 0.15
/** Seconds off the leader at which the rule fires. */
export const FOLLOWER_LINE_SECONDS = 1
/** Fewer steady comparisons than this (1 s) is too little to call the group measured. */
const MIN_STEADY_COMPARISONS = 50

/** One motor's speed on the grid, plus its speed as a fraction of the leader's at each steady moment. */
export interface MotorTrace {
  name: string
  speed: Float64Array
  recordTimes: Float64Array
  /** Logged slower than SLOW_HZ: compared only just after its own records. */
  slow: boolean
  /** Seconds one comparison stands for: 20 ms, or a slow motor's typical gap between records. */
  weight: number
  ratios: number[]
  times: number[]
}

/** A motor's speed on the grid, with empty lists for the ratios. A slowly logged motor counts each record for its typical gap. */
function motorTrace(motor: MotorView, match: MatchView, grid: Float64Array): MotorTrace {
  const velocity = motor.velocity()
  const rate = sampleRate(velocity.series, match.enabled)
  const slow = !!rate && rate.fastHz < SLOW_HZ
  const weight = slow ? 1 / rate.typicalHz : FOLLOWER_DT
  const speed = velocity.onGrid(grid)
  return { name: motor.name, speed, recordTimes: velocity.series.t, slow, weight, ratios: [], times: [] }
}

/** Is this moment just after one of the motor's own records? A slow motor's value between records is stale. */
function hasFreshRecord(m: MotorTrace, t: number): boolean {
  return !m.slow || t - m.recordTimes[indexAt(m.recordTimes, t)] < FOLLOWER_DT
}

/** At every steady moment of the leader (the group's first motor), each motor's speed as a fraction of the leader's. */
export function traceGroup(group: GroupView, match: MatchView): MotorTrace[] {
  const grid = match.grid(FOLLOWER_DT)
  const leader = group.motors[0].velocity().onGrid(grid)
  const halfSecondAgo = Math.round(0.5 / FOLLOWER_DT)
  const motors = group.motors.map((m) => motorTrace(m, match, grid))
  for (let i = halfSecondAgo; i < grid.length; i++) {
    const now = Math.abs(leader[i])
    const before = Math.abs(leader[i - halfSecondAgo])
    const steady = now > 20 && Math.abs(now - before) <= 0.03 * now
    if (!steady) continue
    for (const m of motors) {
      if (!hasFreshRecord(m, grid[i])) continue
      m.ratios.push(Math.abs(m.speed[i]) / now)
      m.times.push(grid[i])
    }
  }
  return motors
}

/** How long the motor ran more than 15 % off the leader (s). */
export function secondsOffLeader(m: MotorTrace): number {
  return m.ratios.filter((r) => Math.abs(1 - r) > OFF_FRACTION).length * m.weight
}

/** The motor that spent longest more than 15 % off the leader, and its furthest moment. */
export function mostOffLeader(motors: MotorTrace[]) {
  let worst = { name: '', secondsOff: 0, steadyShare: 0, median: 1, furthest: 1, at: 0 }
  for (const m of motors) {
    const secondsOff = secondsOffLeader(m)
    if (secondsOff <= worst.secondsOff) continue
    let furthest = 0
    for (let k = 1; k < m.ratios.length; k++) {
      if (Math.abs(1 - m.ratios[k]) > Math.abs(1 - m.ratios[furthest])) furthest = k
    }
    worst = {
      name: m.name,
      secondsOff,
      steadyShare: secondsOff / (m.ratios.length * m.weight),
      median: median(m.ratios),
      furthest: m.ratios[furthest],
      at: m.times[furthest],
    }
  }
  return worst
}

/**
 * The Trends number: seconds the worst follower of any same-loop group ran more than 15 % off its leader. Null when
 * no group could be measured (no match window, signals missing, under 1 s of steady running).
 */
export function worstFollowerSecondsOff(match: MatchView): number | null {
  if (match.autoStart === null || match.matchEnd === null) return null
  let worst: number | null = null
  for (const g of match.profile.motorGroups) {
    if (!g.sameLoop) continue
    const group: GroupView = {
      name: g.name, limits: g.limits, sameLoop: true,
      motors: g.motors.map((m) => ({
        name: m.name, group: g.name,
        supply: () => match.signal(m.supplyCurrent ?? '', `${m.name} supply`),
        stator: () => match.signal(m.statorCurrent ?? '', `${m.name} stator`),
        velocity: () => match.signal(m.velocity ?? '', m.name),
        connected: () => match.signal(m.connected ?? '', `${m.name} connected`),
        temperature: () => match.signal(m.temperature ?? '', `${m.name} temperature`),
      })),
    }
    try {
      const motors = traceGroup(group, match)
      if (motors[0].ratios.length < MIN_STEADY_COMPARISONS) continue
      const s = mostOffLeader(motors).secondsOff
      worst = Math.max(worst ?? 0, s)
    } catch (e) {
      if (!(e instanceof MissingSignal)) throw e
    }
  }
  return worst
}
