/**
 * Sags as stretches: runs of time under the margin line (the brownout setting plus the profile's margin, the line the
 * Power tab's margin figure and `power/margin` use), with how long each lasted, the robot's state as it began, and the
 * biggest motor groups at the lowest point, on average during it and in the half second before. A view only: no rule or
 * threshold reads it. Imported by the Power tab and findings-json, never by power-report.ts or breakdown.ts.
 *
 * The three constants below are NOMAD 6995's defaults (an idea from their sag view; none of their code or wording),
 * assumed here, not measured on our logs.
 */

import { values, type Match } from '../match/match.ts'
import { buildPowerGrid, DT, type PowerGrid } from './battery-model.ts'
import { powerReport } from './power-report.ts'

/** A run of samples under the line shorter than this, s, is dropped (before merging). Assumed. */
export const MIN_SPAN_S = 0.04
/** Two runs with no more than this between them, s, become one stretch. Assumed. */
export const MERGE_GAP_S = 0.25
/** How far back "what led into it" looks, s. Assumed. */
export const LOOK_BEFORE_S = 0.5
/** The most stretches shown, deepest first. */
export const SPAN_CAP = 8

/** A motor group and its supply current, A. Only groups above 1 A are listed, the top 3, largest first. */
export interface Load { group: string; amps: number }

export interface SagSpan {
  /** Robot time of the first sample under the line, s. */
  start: number
  /** Robot time just past the last sample under the line (start + seconds), s. */
  end: number
  /** Length of the stretch, from its first sample to its last; 0 for a point in the fallback. */
  seconds: number
  lowestVolts: number
  lowestAt: number
  /** The robot state at `start` (hold-last); null when there is no state signal or no value yet. */
  stateAtStart: string | null
  atLowest: Load[]
  /** Mean over the stretch; null in the fallback, which has no stretch. */
  during: Load[] | null
  /** Mean over the LOOK_BEFORE_S before `start`, clipped at the grid's start (empty when there is none). */
  before: Load[]
}

export interface SagSpans {
  /** Brownout setting + margin, V; NaN with no brownout setting. */
  line: number
  /** 'stretches', or 'lowest-points' when there is no brownout setting or the match never goes under the line. */
  mode: 'stretches' | 'lowest-points'
  /** Why the fallback is in use; null in 'stretches'. */
  reason: string | null
  /** Deepest first, at most SPAN_CAP. */
  spans: SagSpan[]
  /** Counts before the cap (0 in the fallback, which has no stretches). */
  totalSpans: number
  secondsUnderLine: number
}

// Whole samples, with a hair of slack for 0.04 / 0.02 not being exactly 2 (a gap of 12.5 samples allows 12, not 13).
const MIN_SAMPLES = Math.ceil(MIN_SPAN_S / DT - 1e-9)
const MERGE_GAP_SAMPLES = Math.floor(MERGE_GAP_S / DT + 1e-9)
const LOOK_BEFORE_SAMPLES = Math.round(LOOK_BEFORE_S / DT)

export function buildSagSpans(match: Match): SagSpans | null {
  const cached = match.cache.get('power:sag-spans') as SagSpans | null | undefined
  if (cached !== undefined) return cached
  const out = compute(match)
  match.cache.set('power:sag-spans', out as never)
  return out
}

/** The line, and every stretch under it, deepest first, with no cap and no fallback. Null without a power grid. */
export function sagSpansUncapped(match: Match): { line: number; spans: SagSpan[] } | null {
  const g = buildPowerGrid(match)
  const p = powerReport(match)
  if (!g || !p) return null
  const line = p.brownoutVolts + match.profile.power.marginVolts
  return { line, spans: Number.isFinite(line) ? findSpans(match, g, line) : [] }
}

function compute(match: Match): SagSpans | null {
  const g = buildPowerGrid(match)
  const p = powerReport(match)
  if (!g || !p) return null
  const { line, spans } = sagSpansUncapped(match)!
  if (spans.length) {
    return {
      line, mode: 'stretches', reason: null, spans: spans.slice(0, SPAN_CAP),
      totalSpans: spans.length, secondsUnderLine: spans.reduce((s, x) => s + x.seconds, 0),
    }
  }
  const state = stateReader(match)
  const reason = Number.isFinite(line)
    ? `This match never went under ${line} V while enabled, so these are its lowest points.`
    : 'This log has no brownout setting, so there is no line to measure stretches against; these are the lowest points.'
  return {
    line, mode: 'lowest-points', reason, totalSpans: 0, secondsUnderLine: 0,
    spans: p.sags.map((s) => {
      const i = Math.max(0, Math.min(g.t.length - 1, Math.round((s.t - g.t[0]) / DT)))
      return {
        start: s.t, end: s.t, seconds: 0, lowestVolts: s.volts, lowestAt: s.t, stateAtStart: state(s.t),
        atLowest: s.loads.slice(0, 3).map((l) => ({ group: l.group, amps: l.amps })), during: null, before: meanTop(g, Math.max(0, i - LOOK_BEFORE_SAMPLES), i),
      }
    }),
  }
}

function findSpans(match: Match, g: PowerGrid, line: number): SagSpan[] {
  // Runs of enabled samples with a finite voltage above 0 and under the line, as [first, past-last) sample indexes.
  let runs: [number, number][] = []
  let from = -1
  for (let i = 0; i <= g.t.length; i++) {
    const under = i < g.t.length && g.enabled[i] === 1 && Number.isFinite(g.volts[i]) && g.volts[i] > 0 && g.volts[i] < line
    if (under && from < 0) from = i
    if (!under && from >= 0) { runs.push([from, i]); from = -1 }
  }
  runs = runs.filter(([a, b]) => b - a >= MIN_SAMPLES) // drop the short ones, then merge
  const merged: [number, number][] = []
  for (const r of runs) {
    const last = merged[merged.length - 1]
    if (last && r[0] - last[1] <= MERGE_GAP_SAMPLES) last[1] = r[1]
    else merged.push([r[0], r[1]])
  }

  const state = stateReader(match)
  const spans = merged.map(([a, b]): SagSpan => {
    let low = a
    for (let i = a; i < b; i++) if (g.volts[i] < g.volts[low] || !(g.volts[low] < line)) low = i
    return {
      start: g.t[a], end: g.t[a] + (b - a) * DT, seconds: (b - a) * DT,
      lowestVolts: g.volts[low], lowestAt: g.t[low], stateAtStart: state(g.t[a]),
      atLowest: meanTop(g, low, low + 1), during: meanTop(g, a, b), before: meanTop(g, Math.max(0, a - LOOK_BEFORE_SAMPLES), a),
    }
  })
  return spans.sort((x, y) => x.lowestVolts - y.lowestVolts || x.start - y.start)
}

/** The top 3 motor groups by mean supply current over samples [a, b), amps above 1 only. */
function meanTop(g: PowerGrid, a: number, b: number): Load[] {
  if (b <= a) return []
  return g.groups
    .map((x) => { let s = 0; for (let i = a; i < b; i++) s += x.amps[i]; return { group: x.name, amps: s / (b - a) } })
    .filter((x) => x.amps > 1)
    .sort((x, y) => y.amps - x.amps)
    .slice(0, 3)
}

/** Hold-last robot state at a time; null with no state key, no such signal in the log, or before its first value. */
function stateReader(match: Match): (t: number) => string | null {
  const key = match.profile.signals.robotState ?? match.profile.stateMachine?.state
  const s = key ? values<unknown>(match, key) : null
  if (!s || s.t.length === 0) return () => null
  return (t) => {
    let lo = 0, hi = s.t.length - 1, k = -1
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (s.t[mid] <= t) { k = mid; lo = mid + 1 } else hi = mid - 1 }
    return k < 0 ? null : String(s.v[k])
  }
}
