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
  for (let i = 1; i < s.t.length; i++) if (isTrue(s.v[i]) !== isTrue(s.v[i - 1])) out.push({ t: s.t[i], to: isTrue(s.v[i]) })
  return out
}

export function exitTrigger(match: MatchView, state: string): Trigger {
  const machine = match.profile.stateMachine!
  const logs = [match, ...match.otherLogs().filter((o) => o.profile.name === match.profile.name && o.has(machine.state))]
  const counts = new Map<string, number>() // "key|to" → exits it came before
  let exits = 0
  for (const log of logs) {
    const sensors = machine.sensors.filter((x) => log.has(x.key)).map((x) => ({ key: x.key, flips: flips(log, x.key) }))
    for (const s of stateStretches(log, machine.state)) {
      if (s.state !== state || !s.left || !inside(log.enabled, s.end)) continue
      exits++
      for (const sensor of sensors) {
        const before = sensor.flips.filter((f) => f.t >= s.end - BEFORE_EXIT_SECONDS && f.t < s.end - SAME_LOOP_SECONDS).at(-1)
        if (before) counts.set(`${sensor.key}|${before.to}`, (counts.get(`${sensor.key}|${before.to}`) ?? 0) + 1)
      }
    }
  }
  const across = `${logs.length} loaded log${logs.length === 1 ? '' : 's'}`
  if (exits < MIN_EXITS) return { named: false, key: '', to: true, words: '', text: `not learned: ${state} ended ${exits} time${exits === 1 ? '' : 's'} while enabled in the ${across} (needs ${MIN_EXITS} or more: load more logs of this robot)` }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]
  if (!best) return { named: false, key: '', to: true, words: '', text: `not learned: no profile sensor flipped before any of its ${exits} exits in the ${across}` }
  const [key, toText] = best[0].split('|')
  const to = toText === 'true'
  const words = `${machine.sensors.find((x) => x.key === key)!.name} turns ${to}`
  if (best[1] < MIN_SHARE * exits) return { named: false, key, to, words, text: `not learned: the most common, ${words}, came before ${best[1]} of ${exits} exits (needs ${100 * MIN_SHARE} %)` }
  return { named: true, key, to, words, text: `${words}: in the ${BEFORE_EXIT_SECONDS} s before ${best[1]} of ${exits} exits in the ${across} (across builds); such a flip comes in ${baseRate(logs, key, to)} of any ${BEFORE_EXIT_SECONDS} s while enabled` }
}

/** Share of enabled time that has a flip of this sensor this way in the 0.3 s before it, over the logs. */
function baseRate(logs: MatchView[], key: string, to: boolean): string {
  let covered = 0, total = 0
  for (const log of logs) {
    if (!log.has(key)) continue
    total += lengthOf(log.enabled)
    let until = -Infinity // flips' windows can overlap: count each second once
    for (const f of flips(log, key).filter((x) => x.to === to)) {
      const from = Math.max(f.t, until), end = f.t + BEFORE_EXIT_SECONDS
      for (const iv of log.enabled) covered += Math.max(0, Math.min(end, iv.end) - Math.max(from, iv.start))
      until = Math.max(until, end)
    }
  }
  return total > 0 ? `${(100 * covered / total).toFixed(1)} %` : 'unknown'
}
