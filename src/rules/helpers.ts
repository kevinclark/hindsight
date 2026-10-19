/** Small helpers shared by rules. Each is a plain function; read it before using it. */

import type { Match } from '../match/match.ts'
import { phaseAt, matchTimeLeft } from '../match/match.ts'
import type { Interval, NumberSeries } from '../match/series.ts'

/** "532.8 s (teleop, 17.7 s left)" — the standard way to say when something happened. */
export function when(match: Match, t: number): string {
  const phase = phaseAt(match, t)
  if (phase === 'disabled') return `${t.toFixed(1)} s (disabled)`
  const left = matchTimeLeft(match, t).secondsLeft
  return `${t.toFixed(1)} s (${phase}, ${Math.max(0, left).toFixed(1)} s left)`
}

/** True when t is inside the match: from the first enable to the end of the last enabled period. */
export function inMatch(match: Match, t: number): boolean {
  return match.matchStart !== null && match.matchEnd !== null && t >= match.matchStart && t <= match.matchEnd
}

/** True when the robot was enabled at time t. */
export function isEnabled(match: Match, t: number): boolean {
  return match.enabled.some((iv) => t >= iv.start && t < iv.end)
}

/**
 * Intervals where a numeric signal satisfies `test`, using hold-last: a record's value lasts until the next
 * record. Only the parts inside `within` (e.g. enabled time) are kept.
 */
export function intervalsWhere(s: NumberSeries, test: (v: number) => boolean, within: Interval[], endTime: number): Interval[] {
  const out: Interval[] = []
  for (let i = 0; i < s.t.length; i++) {
    if (!test(s.v[i])) continue
    const start = s.t[i]
    const end = i + 1 < s.t.length ? s.t[i + 1] : endTime
    for (const w of within) {
      const a = Math.max(start, w.start)
      const b = Math.min(end, w.end)
      if (b > a) out.push({ start: a, end: b })
    }
  }
  return mergeIntervals(out)
}

/** Join intervals that touch or overlap. */
export function mergeIntervals(list: Interval[], gap = 0): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const iv of sorted) {
    const last = out.at(-1)
    if (last && iv.start <= last.end + gap) last.end = Math.max(last.end, iv.end)
    else out.push({ ...iv })
  }
  return out
}

/** Largest value in [from, to] (records only), with its time. */
export function peakIn(s: NumberSeries, from: number, to: number): { value: number; t: number } {
  let best = { value: -Infinity, t: NaN }
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] < from || s.t[i] > to) continue
    if (s.v[i] > best.value) best = { value: s.v[i], t: s.t[i] }
  }
  return best
}

/** Smallest value in [from, to] (records only), with its time. */
export function lowIn(s: NumberSeries, from: number, to: number): { value: number; t: number } {
  let best = { value: Infinity, t: NaN }
  for (let i = 0; i < s.t.length; i++) {
    if (s.t[i] < from || s.t[i] > to) continue
    if (s.v[i] < best.value) best = { value: s.v[i], t: s.t[i] }
  }
  return best
}

/** Times where a 0/1 signal goes from false to true. */
export function risingEdges(s: NumberSeries): number[] {
  const out: number[] = []
  for (let i = 0; i < s.t.length; i++) {
    const before = i === 0 ? 0 : s.v[i - 1]
    if (s.v[i] > 0.5 && before <= 0.5) out.push(s.t[i])
  }
  return out
}
