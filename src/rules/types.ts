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
  /** The moment it happened, in robot (log) seconds (null for whole-match findings). */
  time: number | null
  /** The same moment in seconds into the match (from the start of auto), or null. */
  matchTime: number | null
  /** The same moment in words, match time first: "1:47 into the match (teleop; robot time 532.8 s)". */
  when: string | null
  /** What it is about (a motor, a camera, an axis), or null for the whole match. */
  about: string | null
  /** The issue's identity across matches: the rule, plus what it is about. Known-issue tracking uses it. */
  key: string
  /** The numbers behind the finding. Keys are plain-English labels. */
  evidence: Record<string, number | string>
  /** The judged number against its threshold (first), plus context numbers. See Problem.measured. */
  measured?: { label: string; value: number; unit: string; threshold?: number }[]
  plot?: Plot
  /** What it probably means, the possible causes (this log's likely ones first) and the next step. */
  meaning: string
  causes: { id: string; cause: string; look: string; likely?: boolean; ruledOut?: string }[]
  nextStep: string
  /**
   * The finding in the same match that explains this one, from a link in src/rules/links.ts (the brownout that
   * dropped this device off CAN). The app shows this finding under that one. Left out when nothing explains it.
   */
  explainedBy?: { rule: string; about: string | null; time: number | null; why: string }
  /**
   * Set only by the team's history (triage/track-record.ts), never by a rule: the same check was marked "not a real
   * problem" on another match of this event, so this red shows amber. `match` is that match ("Q4").
   */
  demoted?: { match: string; reason: string; when: string }
}
