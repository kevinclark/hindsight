/**
 * Did one motor of a same-loop group run free of the mechanism while the others carried the load?
 *
 * Checks: each motor group marked `sameLoop` with two or more motors that log velocity and stator current. Every 20 ms
 * of the match is compared when the robot is enabled, every motor that has a Connected flag reads connected, and every
 * motor turns faster than 5 (its own velocity unit). At such a moment a motor is free when it turns more than 4 %
 * faster than the median of the others and draws under half their median stator current. A stretch is an unbroken run
 * of moments where the same motor is free; a moment that is not compared ends it. Fires when a motor's longest stretch
 * is 2 s or more, and reports that motor.
 * Why: a coupled motor can only turn faster than its partners and draw less current when it no longer drives the load
 * (a belt that came off, a pulley loose on its shaft, a broken coupling). A follower that lost its Follower request is
 * dragged at the same speed, so it doesn't fire this; mech/follower-mismatch and can/* cover that.
 * Logged slowly (throttled telemetry): not special-cased. A stale value can only hold for one record gap, far under the
 * 2 s a stretch needs, and a free motor stays free at every record.
 * One 2026 robot: a kicker motor ran free in parts of four matches and nothing flagged it (the kicker shared a group with
 * the indexer feed motor and had no velocity key; mech/follower-mismatch needs a leader above 20 rot/s).
 */
import { median, round, rule, secs, type Problem } from '../rule.ts'
import { CTRE_FOLLOWER_API } from '../sources.ts'
import { MissingSignal, inside, type GroupView, type MatchView, type MotorView } from '../view.ts'

const GRID_DT = 0.02 // compare every 20 ms
/** Every motor must turn faster than this (in its own velocity unit) for a moment to be compared. */
export const RUNNING_ABOVE = 5
/** A motor is "faster" when it turns more than this multiple of the median of the others. */
export const FASTER_THAN = 1.04
/** A motor is "carrying less" when it draws under this fraction of the others' median stator current. */
export const CURRENT_UNDER = 0.5
/** Seconds of one unbroken stretch at which the rule fires. */
export const FREE_LINE_SECONDS = 2

interface Stretch { motor: number; start: number; end: number; moments: number }

export default rule({
  id: 'mech/motor-running-free',
  title: 'A motor ran free of its mechanism',
  severity: 'warning',
  judges: 'fault',
  who: ['pit'],
  meaning: 'One motor turned faster than its partners while drawing far less current, so it was no longer driving the mechanism. The others carried the load alone.',
  causes: [
    { id: 'belt-off', cause: 'A belt that came off, or walked off a pulley after a flange popped', look: 'that motor\'s belt, its pulleys and flanges, and how the belt tracks' },
    { id: 'loose', cause: 'A pulley or gear loose on its shaft (set screw, key)', look: 'the set screws and keys on that motor\'s pulley, with the robot off' },
    { id: 'broken', cause: 'A broken coupling or shaft between the motor and the mechanism', look: 'the motor shaft and whatever joins it to the mechanism' },
  ],
  nextStep: 'With the robot off, spin the free motor\'s pulley by hand and check that it drives the mechanism. Check flanges, belt tracking and set screws on that motor\'s drive.',
  incident: 'One 2026 event: a kicker motor ran free in parts of four matches (a belt or pulley came off its drive); nothing flagged it.',
  sources: [
    { ...CTRE_FOLLOWER_API, says: 'A Follower control request makes a Talon mirror another Talon\'s output, so a healthy follower turns with its leader; a motor that outruns its partners on little current is not driving the same load.' },
  ],
  thresholds: [
    { name: 'time free', value: '2 s or more in one stretch', basis: 'measured', how: 'One 2026 robot, 22 match logs: 4 episodes, longest stretches 4.7–12.5 s; healthy pairs never ran apart more than 0.1 s (kicker) or 0.5 s (intake rollers) at a stretch.' },
    { name: 'faster than the others', value: 'more than 4 % above their median speed', basis: 'judgment', how: 'Chosen: a coupled pair at the same speed read well inside 4 % in healthy logs.' },
    { name: 'carrying less', value: 'under half the others\' median stator current', basis: 'judgment', how: 'Chosen: the free motor read 3–4 A against 19–32 A.' },
    { name: 'running', value: 'every motor above 5 in its own velocity unit', basis: 'judgment', how: 'Chosen: slower than this the speeds are too small to compare.' },
  ],
  forEach: 'motorGroup',
  only: (group) => group.sameLoop,
  needsEnabled: true,
  check(group, match) {
    const motors = group.motors.flatMap((m) => {
      try {
        return [{ m, speed: m.velocity(), stator: m.stator() }]
      } catch (e) {
        if (e instanceof MissingSignal) return []
        throw e
      }
    })
    if (motors.length < 2) throw new MissingSignal(`two motors of ${group.name} with velocity and stator current`)

    const grid = match.grid(GRID_DT)
    const speed = motors.map((x) => x.speed.onGrid(grid))
    const stator = motors.map((x) => x.stator.onGrid(grid))
    const connected = motors.map((x) => connectedOnGrid(x.m, grid))

    // For each moment: which motor is free (-1: none, or the moment isn't compared). null: not compared.
    let compared = 0
    let comparedMoments = 0
    const stretches: Stretch[] = []
    let open: Stretch | null = null
    const close = () => {
      if (open) stretches.push(open)
      open = null
    }
    for (let i = 0; i < grid.length; i++) {
      const t = grid[i]
      const comparable = inside(match.enabled, t) && motors.every((_, k) => connected[k][i] && Math.abs(speed[k][i]) > RUNNING_ABOVE)
      if (!comparable) {
        close()
        continue
      }
      comparedMoments++
      let free = -1
      for (let k = 0; k < motors.length; k++) {
        const others = motors.map((_, j) => j).filter((j) => j !== k)
        const otherSpeed = median(others.map((j) => Math.abs(speed[j][i])))
        const otherAmps = median(others.map((j) => Math.abs(stator[j][i])))
        if (Math.abs(speed[k][i]) > FASTER_THAN * otherSpeed && Math.abs(stator[k][i]) < CURRENT_UNDER * otherAmps) {
          free = k
          break
        }
      }
      if (free < 0) {
        close()
      } else if (open && (open as Stretch).motor === free) {
        const o = open as Stretch
        o.end = t
        o.moments++
      } else {
        close()
        open = { motor: free, start: t, end: t, moments: 1 }
      }
    }
    close()
    compared = comparedMoments

    if (compared === 0) {
      return match.couldNotCheck(`the motors never all ran above ${RUNNING_ABOVE} together while enabled and connected`)
    }

    const seconds = (s: Stretch) => s.moments * GRID_DT
    let worst: Stretch | null = null
    for (const s of stretches) if (!worst || seconds(s) > seconds(worst)) worst = s
    if (!worst || seconds(worst) < FREE_LINE_SECONDS) return

    const k = worst.motor
    const name = motors[k].m.name
    const others = motors.map((_, j) => j).filter((j) => j !== k)
    const at = (s: Stretch) => {
      const idx: number[] = []
      for (let i = 0; i < grid.length; i++) if (grid[i] >= s.start && grid[i] <= s.end) idx.push(i)
      return idx
    }
    const idx = at(worst)
    const freeSpeed = median(idx.map((i) => Math.abs(speed[k][i])))
    const freeAmps = median(idx.map((i) => Math.abs(stator[k][i])))
    const othersSpeed = median(idx.flatMap((i) => others.map((j) => Math.abs(speed[j][i]))))
    const othersAmps = median(idx.flatMap((i) => others.map((j) => Math.abs(stator[j][i]))))
    const faster = round(100 * (freeSpeed / othersSpeed - 1), 0)
    const longest = round(seconds(worst), 1)
    const total = round(stretches.filter((s) => s.motor === k).reduce((n, s) => n + seconds(s), 0), 1)

    const problem: Problem = {
      message: `${name} ran free for ${secs(seconds(worst))} (longest stretch): ${faster} % faster than the others on ${round(freeAmps, 0)} A against ${round(othersAmps, 0)} A`,
      at: worst.start,
      evidence: {
        'free motor': name,
        'longest free stretch (s)': longest,
        'total free seconds': total,
        'stretch from (s)': round(worst.start, 1),
        'stretch to (s)': round(worst.end, 1),
        'free motor: median speed': round(freeSpeed, 1),
        'free motor: median stator current (A)': round(freeAmps, 1),
        'others: median speed': round(othersSpeed, 1),
        'others: median stator current (A)': round(othersAmps, 1),
      },
      measured: [
        { label: `${name}: seconds running free (longest stretch)`, value: longest, unit: 's', threshold: FREE_LINE_SECONDS, short: 'running free', one: `${name}: second running free` },
        { label: `${name}: how much faster than the others`, value: faster, unit: '%' },
      ],
      plot: { signals: group.motors.map((m) => m.velocity()), unit: 'rot/s' },
    }
    return problem
  },
})

/** Is the motor connected at each grid moment? A motor with no Connected flag (in the profile or the log) always is. */
function connectedOnGrid(motor: MotorView, grid: Float64Array): boolean[] {
  try {
    return Array.from(motor.connected().onGrid(grid), (v) => v >= 0.5)
  } catch (e) {
    if (e instanceof MissingSignal) return Array.from(grid, () => true)
    throw e
  }
}
