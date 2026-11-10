/**
 * Where the power went: energy, running time and current per motor group over the enabled match, and the same split
 * by the robot's state. A view only: no rule or threshold reads it. Imported by the Power tab and findings-json, never
 * by power-report.ts or summary.ts.
 *
 * Energy is supply current × battery voltage × the grid step, over enabled samples. A sample whose voltage is NaN
 * contributes nothing to energy (the current grid can carry NaN volts); it still counts as running time and current.
 */

import { values, type Match } from '../match/match.ts'
import { percentile } from '../match/series.ts'
import { buildPowerGrid, DT, type PowerGrid } from './battery-model.ts'

/** A motor group is running when its supply current is above this, A. NOMAD's default; assumed, not measured here. */
export const RUNNING_AMPS = 1
/** A group's states with less running than this, s, fold into one "Other states" row. Assumed, to keep the table short. */
export const MIN_STATE_RUNNING_S = 1

export const NO_STATE = 'No state logged'
export const OTHER_STATES = 'Other states'

export interface BreakdownStats {
  /** Energy, Wh. */
  wh: number
  /** Seconds with current above RUNNING_AMPS; null for a row that has no motor current (other loads). */
  runningSeconds: number | null
  /** Percentiles of the current over the running samples, A; null with none, and for other loads. */
  p50: number | null
  p90: number | null
  p99: number | null
  /** Largest current while enabled, A; null for other loads. */
  peak: number | null
}

export interface StateRow extends BreakdownStats { name: string }

export interface BreakdownRow extends BreakdownStats {
  name: string
  kind: 'group' | 'other' | 'whole'
  /** By robot state, largest energy first; empty when there is no state signal (see Breakdown.stateNote). */
  states: StateRow[]
}

export interface Breakdown {
  rows: BreakdownRow[]
  totalWh: number
  enabledSeconds: number
  /** Why `states` is empty, when it is. */
  stateNote: string | null
  runningAmps: number
  otherLoadsAmps: number
  /** True when the one row is a measured total, not the sum of motors. */
  measured: boolean
}

/** A group has states worth opening: a state row besides the fold and "No state logged" that ran. */
export function hasStates(r: { states: { name: string; runningSeconds: number | null }[] }): boolean {
  return r.states.some((s) => s.name !== OTHER_STATES && s.name !== NO_STATE && (s.runningSeconds ?? 0) > 0)
}

/** One row's samples as they are gathered. */
class Acc {
  wh = 0
  running: number[] = []
  peak = 0
  add(amps: number, volts: number) {
    if (Number.isFinite(volts)) this.wh += amps * volts * DT / 3600
    if (amps > RUNNING_AMPS) this.running.push(amps)
    if (amps > this.peak) this.peak = amps
  }
  stats(): BreakdownStats {
    const r = this.running
    return {
      wh: this.wh, runningSeconds: r.length * DT,
      p50: r.length ? percentile(r, 50) : null, p90: r.length ? percentile(r, 90) : null, p99: r.length ? percentile(r, 99) : null,
      peak: this.peak,
    }
  }
  merge(o: Acc) { this.wh += o.wh; this.running.push(...o.running); this.peak = Math.max(this.peak, o.peak) }
}

export function buildBreakdown(match: Match): Breakdown | null {
  const cached = match.cache.get('power:breakdown') as Breakdown | null | undefined
  if (cached !== undefined) return cached
  const out = compute(match)
  match.cache.set('power:breakdown', out as never)
  return out
}

/** The state at each grid sample: the last value at or before it (hold-last); null before the first value. */
function stateAt(match: Match, g: PowerGrid): { names: (string | null)[]; note: string | null } {
  const key = match.profile.signals.robotState ?? match.profile.stateMachine?.state
  const none = (note: string) => ({ names: [], note })
  if (!key) return none("This robot's profile names no state signal, so the split by state isn't shown.")
  const s = values<unknown>(match, key)
  if (!s || s.t.length === 0) return none(`This log has no ${key}, so the split by state isn't shown.`)
  const names: (string | null)[] = new Array(g.t.length)
  let k = -1
  for (let i = 0; i < g.t.length; i++) {
    while (k + 1 < s.t.length && s.t[k + 1] <= g.t[i]) k++
    names[i] = k < 0 ? null : String(s.v[k])
  }
  return { names, note: null }
}

function compute(match: Match): Breakdown | null {
  const g = buildPowerGrid(match)
  if (!g) return null
  const { names, note } = stateAt(match, g)
  const withStates = note === null
  const other = match.profile.power.otherLoadsAmps

  // One accumulator per output row, and per row a map of state name to its accumulator.
  type Src = { name: string; kind: BreakdownRow['kind']; amps: Float64Array | null; fixed?: number }
  const sources: Src[] = g.currentFrom
    ? [{ name: 'Whole robot (measured)', kind: 'whole', amps: g.amps }]
    : [...g.groups.map((x) => ({ name: x.name, kind: 'group' as const, amps: x.amps })),
       { name: `Other loads (assumed ${other} A)`, kind: 'other' as const, amps: null, fixed: other }]
  const accs = sources.map(() => new Acc())
  const byState = sources.map(() => new Map<string, Acc>())

  let enabled = 0
  for (let i = 0; i < g.t.length; i++) {
    if (!g.enabled[i]) continue
    enabled++
    const st = names[i] ?? NO_STATE
    sources.forEach((src, si) => {
      const a = src.amps ? src.amps[i] : src.fixed!
      accs[si].add(a, g.volts[i])
      if (withStates && src.kind !== 'other') {
        let m = byState[si].get(st)
        if (!m) byState[si].set(st, (m = new Acc()))
        m.add(a, g.volts[i])
      }
    })
  }

  const rows: BreakdownRow[] = sources.map((src, si) => {
    const s = accs[si].stats()
    const row: BreakdownRow = src.kind === 'other'
      ? { name: src.name, kind: src.kind, wh: s.wh, runningSeconds: null, p50: null, p90: null, p99: null, peak: null, states: [] }
      : { name: src.name, kind: src.kind, ...s, states: [] }
    if (withStates && src.kind !== 'other') {
      const kept: [string, Acc][] = []
      const folded = new Acc()
      let anyFolded = false
      for (const [name, a] of byState[si]) {
        if (name !== NO_STATE && a.running.length * DT < MIN_STATE_RUNNING_S) { folded.merge(a); anyFolded = true } else kept.push([name, a])
      }
      row.states = kept.map(([name, a]) => ({ name, ...a.stats() }))
      if (anyFolded) row.states.push({ name: OTHER_STATES, ...folded.stats() })
      // Largest energy first; the fold row is a sum of small ones, so it sits where its energy puts it
      row.states.sort((x, y) => y.wh - x.wh)
    }
    return row
  })
  rows.sort((x, y) => y.wh - x.wh)
  return {
    rows, totalWh: rows.reduce((s, r) => s + r.wh, 0), enabledSeconds: enabled * DT, stateNote: note,
    runningAmps: RUNNING_AMPS, otherLoadsAmps: other, measured: !!g.currentFrom,
  }
}
