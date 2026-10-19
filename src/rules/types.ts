/**
 * What the runner produces from a rule's answer: a finding, with everything the report and findings.json need.
 * Rules don't build these themselves; they return a Problem (src/rules/rule.ts).
 */

import type { NumberSeries } from '../match/series.ts'
import type { Severity } from './rule.ts'

export type { Audience, Severity } from './rule.ts'

/** A line on a finding's plot: either a log key, or a series (e.g. degrees instead of radians). */
export interface PlotLine {
  label: string
  key?: string
  data?: NumberSeries
  /** Multiply values by this before plotting. */
  scale?: number
}

export interface Plot {
  from: number
  to: number
  lines: PlotLine[]
  /** A horizontal reference line, e.g. the brownout voltage. */
  threshold?: { value: number; label: string }
  /** Vertical markers at moments that matter. */
  markers?: { t: number; label: string }[]
  unit: string
}

export interface Finding {
  rule: string
  severity: Severity
  /** One line: what happened, in plain words. */
  title: string
  /** The moment it happened, in log seconds (null for whole-match findings). */
  time: number | null
  /** What it is about (a motor, a camera, an axis), or null for the whole match. */
  about: string | null
  /** The issue's identity across matches: the rule, plus what it is about. Known-issue tracking uses it. */
  key: string
  /** The numbers behind the finding. Keys are plain-English labels. */
  evidence: Record<string, number | string>
  plot?: Plot
}
