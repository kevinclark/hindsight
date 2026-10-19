/** Turn a finding's plot description into arrays the Plot component can draw. */

import { has, num, type Match } from '../match/match.ts'
import { indexAt, slice } from '../match/series.ts'
import { downsample } from '../report/findings-json.ts'
import type { Plot as PlotSpec } from '../rules/types.ts'

export interface PlotSeries { label: string; t: number[]; v: number[] }

export interface PlotModel {
  from: number
  to: number
  unit: string
  series: PlotSeries[]
  threshold?: { value: number; label: string }
  markers?: { t: number; label: string }[]
}

const MAX_POINTS = 600

export function plotModel(match: Match, spec: PlotSpec): PlotModel {
  const series: PlotSeries[] = []
  for (const line of spec.lines) {
    const s = line.data ?? (line.key && has(match, line.key) ? num(match, line.key) : null)
    if (!s) continue
    // Include the record before the window so hold-last draws from the left edge.
    const part = slice(s, spec.from, spec.to)
    const before = indexAt(s.t, spec.from)
    const d = downsample(part, MAX_POINTS)
    if (before >= 0) { d.t.unshift(spec.from); d.v.unshift(s.v[before]) }
    const scale = line.scale ?? 1
    series.push({ label: line.label, t: d.t, v: d.v.map((x) => x * scale) })
  }
  return { from: spec.from, to: spec.to, unit: spec.unit, series, threshold: spec.threshold, markers: spec.markers }
}
