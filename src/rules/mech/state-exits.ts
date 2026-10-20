/**
 * What a state machine's state waits for, learned from how it normally leaves (for mech/stuck-state).
 *
 * For each exit from the state while enabled, in this log and every other loaded log of the same robot, look at the
 * profile's sensors in the 0.3 s before the exit: which one flipped, and which way. A flip in the same loop as the
 * exit is left out, because a sensor can change as a result of leaving (MTTD 2025: "At Extension? → false" came with
 * 100 % of exits). The sensor and direction seen before the most exits is the trigger, named only with 5 exits or more
 * and 80 % of them. Its base rate (how much of the enabled time has such a flip in the 0.3 s before) says whether
 * the match is better than chance: arm has-piece → true came before 33 of 33 MTTD handoff exits, at a 1 % base rate.
 */
import { isTrue } from '../rule.ts'
import { inside, lengthOf, type MatchView } from '../view.ts'

const BEFORE_EXIT_SECONDS = 0.3
const SAME_LOOP_SECONDS = 0.005 // records of one robot loop share a timestamp; anything earlier is an earlier loop
const MIN_EXITS = 5 // the floor Kevin set (2026-10-19)
const MIN_SHARE = 0.8

type StateMachine = NonNullable<MatchView['profile']['stateMachine']>

export interface Trigger {
  named: boolean
  key: string
  /** The value the sensor turns to: true or false. */
  to: boolean
  /** "Arm has game piece turns true" */
  words: string
  /** The evidence line: what was learned, or why nothing was. */
  text: string
}

/** Each stretch the state signal held one value: its start, end, and whether it left (false at the end of the log). */
export function stateStretches(match: MatchView, key: string): { state: string; start: number; end: number; left: boolean }[] {
  const s = match.text(key).series
  const out: { state: string; start: number; end: number; left: boolean }[] = []
  for (let i = 0; i < s.t.length; i++) {
    const last = out.at(-1)
    if (last && last.state === s.v[i]) continue
    if (last) { last.end = s.t[i]; last.left = true }
    out.push({ state: s.v[i], start: s.t[i], end: match.logEnd, left: false })
  }
  return out
}

/** Times a true/false signal changed value, and to what. */
function flips(match: MatchView, key: string): { t: number; to: boolean }[] {
  const s = match.signal(key).series
  const out: { t: number; to: boolean }[] = []
  for (let i = 1; i < s.t.length; i++) {
    if (isTrue(s.v[i]) !== isTrue(s.v[i - 1])) out.push({ t: s.t[i], to: isTrue(s.v[i]) })
  }
  return out
}

export function exitTrigger(match: MatchView, state: string): Trigger {
  const machine = match.profile.stateMachine!
  const sameRobot = match.otherLogs().filter((o) => o.profile.name === match.profile.name && o.has(machine.state))
  const logs = [match, ...sameRobot]
  const across = `${logs.length} loaded log${logs.length === 1 ? '' : 's'}`

  const { exits, candidates } = countExits(logs, machine, state)
  if (exits < MIN_EXITS) {
    const ended = `${exits} time${exits === 1 ? '' : 's'}`
    const text = `not learned: ${state} ended ${ended} while enabled in the ${across} (needs ${MIN_EXITS} or more: load more logs of this robot)`
    return { named: false, key: '', to: true, words: '', text }
  }
  // The flip seen before the most exits (the first one found, on a tie).
  const best = candidates.sort((a, b) => b.exits - a.exits)[0]
  if (!best) {
    const text = `not learned: no profile sensor flipped before any of its ${exits} exits in the ${across}`
    return { named: false, key: '', to: true, words: '', text }
  }
  const { key, to } = best
  const words = `${machine.sensors.find((x) => x.key === key)!.name} turns ${to}`
  if (best.exits < MIN_SHARE * exits) {
    const text = `not learned: the most common, ${words}, came before ${best.exits} of ${exits} exits (needs ${100 * MIN_SHARE} %)`
    return { named: false, key, to, words, text }
  }
  const text = `${words}: in the ${BEFORE_EXIT_SECONDS} s before ${best.exits} of ${exits} exits in the ${across} (across builds); `
    + `such a flip comes in ${baseRate(logs, key, to)} of any ${BEFORE_EXIT_SECONDS} s while enabled`
  return { named: true, key, to, words, text }
}

/** How many times the state was left while enabled, and for each sensor flip, how many of those exits it came before. */
function countExits(logs: MatchView[], machine: StateMachine, state: string) {
  const candidates: { key: string; to: boolean; exits: number }[] = []
  let exits = 0
  for (const log of logs) {
    const sensors = machine.sensors.filter((x) => log.has(x.key)).map((x) => ({ key: x.key, flips: flips(log, x.key) }))
    for (const stretch of stateStretches(log, machine.state)) {
      if (stretch.state !== state || !stretch.left || !inside(log.enabled, stretch.end)) continue
      exits++
      for (const sensor of sensors) {
        // The last flip in the 0.3 s before the exit, but not in the exit's own loop.
        const from = stretch.end - BEFORE_EXIT_SECONDS
        const until = stretch.end - SAME_LOOP_SECONDS
        const before = sensor.flips.filter((f) => f.t >= from && f.t < until).at(-1)
        if (!before) continue
        const seen = candidates.find((c) => c.key === sensor.key && c.to === before.to)
        if (seen) seen.exits++
        else candidates.push({ key: sensor.key, to: before.to, exits: 1 })
      }
    }
  }
  return { exits, candidates }
}

/** Share of enabled time that has a flip of this sensor this way in the 0.3 s before it, over the logs. */
function baseRate(logs: MatchView[], key: string, to: boolean): string {
  let covered = 0
  let total = 0
  for (const log of logs) {
    if (!log.has(key)) continue
    total += lengthOf(log.enabled)
    let until = -Infinity // flips' windows can overlap: count each second once
    for (const f of flips(log, key).filter((x) => x.to === to)) {
      const from = Math.max(f.t, until)
      const end = f.t + BEFORE_EXIT_SECONDS
      for (const iv of log.enabled) covered += Math.max(0, Math.min(end, iv.end) - Math.max(from, iv.start))
      until = Math.max(until, end)
    }
  }
  return total > 0 ? `${(100 * covered / total).toFixed(1)} %` : 'unknown'
}
