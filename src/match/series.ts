/**
 * Time series helpers. Every signal is a list of (time, value) records, logged only when the value changed.
 *
 * The one rule to remember: the value at time t is the LAST record at or before t ("hold last").
 * Never interpolate between records; a value that didn't change wasn't logged again.
 */

export interface NumberSeries {
  name: string
  /** Seconds since the robot program started (the wpilog clock). Sorted ascending. */
  t: Float64Array
  v: Float64Array
}

export interface ValueSeries<T> {
  name: string
  t: Float64Array
  v: T[]
}

export interface Interval {
  start: number
  end: number
}

/** Index of the last record at or before time t, or -1 when t is before the first record. */
export function indexAt(t: Float64Array, time: number): number {
  let lo = 0
  let hi = t.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= time) { found = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  return found
}

/** Value held at time t (NaN before the first record). */
export function valueAt(s: NumberSeries, time: number): number {
  const i = indexAt(s.t, time)
  return i < 0 ? NaN : s.v[i]
}

/** Same as valueAt for any series type (undefined before the first record). */
export function heldAt<T>(s: ValueSeries<T>, time: number): T | undefined {
  const i = indexAt(s.t, time)
  return i < 0 ? undefined : s.v[i]
}

/** An evenly spaced time grid from start to end (exclusive), step dt seconds. */
export function makeGrid(start: number, end: number, dt: number): Float64Array {
  const n = Math.max(0, Math.floor((end - start) / dt))
  const grid = new Float64Array(n)
  for (let i = 0; i < n; i++) grid[i] = start + i * dt
  return grid
}

/** Hold-last resample onto a grid. Before the first record the value is `before` (default NaN). */
export function resample(s: NumberSeries, grid: Float64Array, before = NaN): Float64Array {
  const out = new Float64Array(grid.length)
  let j = -1
  for (let i = 0; i < grid.length; i++) {
    while (j + 1 < s.t.length && s.t[j + 1] <= grid[i]) j++
    out[i] = j < 0 ? before : s.v[j]
  }
  return out
}

/** Records within [from, to]. */
export function slice(s: NumberSeries, from: number, to: number): NumberSeries {
  let a = indexAt(s.t, from)
  if (a < 0 || s.t[a] < from) a++
  const b = indexAt(s.t, to) + 1
  return { name: s.name, t: s.t.subarray(a, b), v: s.v.subarray(a, b) }
}

/** Sum the lengths of intervals, optionally clipped to [from, to]. */
export function totalDuration(intervals: Interval[], from = -Infinity, to = Infinity): number {
  let sum = 0
  for (const iv of intervals) sum += Math.max(0, Math.min(iv.end, to) - Math.max(iv.start, from))
  return sum
}

/** Smallest and largest of a list (a loop: Math.min(...list) throws on very long lists). NaN when empty. */
export function minOf(values: ArrayLike<number>): number {
  let m = Infinity
  for (let i = 0; i < values.length; i++) if (values[i] < m) m = values[i]
  return values.length ? m : NaN
}

export function maxOf(values: ArrayLike<number>): number {
  let m = -Infinity
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i]
  return values.length ? m : NaN
}

/** Percentile (0–100) of a list of numbers, ignoring NaN. NaN when empty. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Array.from(values).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b)
  if (sorted.length === 0) return NaN
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[k]
}

export function median(values: ArrayLike<number>): number {
  return percentile(values, 50)
}

/** Round for display and evidence: round(12.3456, 2) = 12.35. */
export function round(x: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}
