/**
 * What a rule is and what it returns. Every rule file in src/rules/<area>/<rule>.ts exports one `Rule`.
 */

import type { Match } from '../match/match.ts'
import type { NumberSeries } from '../match/series.ts'

/** red = it cost or nearly cost a match; amber = a margin is eroding; grey = context. */
export type Severity = 'error' | 'warning' | 'info'

/** A line on a finding's plot: either a log key, or a series the rule computed (e.g. total current). */
export interface PlotLine {
  label: string
  key?: string
  data?: NumberSeries
  /** Multiply values by this before plotting (e.g. radians → degrees). */
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
  /** The numbers behind the finding. Keys are plain-English labels. */
  evidence: Record<string, number | string>
  plot?: Plot
}

export interface NotChecked {
  notChecked: string
}

export interface Rule {
  /** "<area>/<name>", matching the file path. */
  id: string
  title: string
  /** What to do when it fires. Shown under every finding. */
  fix: string
  /** The incident that taught us this rule. */
  incident: string
  /** Log keys this rule cannot run without. If any is missing, the rule is listed as "not checked". */
  needs: (match: Match) => string[]
  run: (match: Match) => Finding[] | NotChecked
}
