/**
 * A match's .hoot readings, lined up with its robot log and handed to the experimental rules (ADR 14). Pure: the page
 * holds the readings (the desktop app reads them through owlet) and attaches them again after every analysis pass,
 * because each pass builds a new Match. The Devices tab lines files up with the same `alignTo`, so the two never disagree.
 */
import { readNumbers } from '../readers/wpilog.ts'
import type { Match } from '../match/match.ts'
import { withExperimental, type Report } from '../rules/index.ts'
import { align, edgesOf, type Alignment, type Edge } from './align.ts'
import { changes } from './reduce.ts'
import type { HootReading } from './types.ts'

export interface HootAttachment {
  reading: HootReading
  /** robot-log time = hoot time + offset, or why the file couldn't be lined up. */
  alignment: Alignment
}

export const NO_ENABLED_SIGNAL = "this log's robot profile names no enabled signal to line up by"

/** The robot log's own enables and disables, which each .hoot is lined up against. */
export function logEnableEdges(match: Pick<Match, 'log' | 'profile'>): Edge[] {
  const key = match.profile.signals.enabled
  const s = key ? readNumbers(match.log, key) : null
  return edgesOf(changes(s).map((c) => ({ t: c.t, on: c.v !== 0 })))
}

/** How one .hoot lines up with this robot log (by enable edges, src/hoot/align.ts). */
export function alignTo(match: Pick<Match, 'log' | 'profile'>, reading: HootReading, edges = logEnableEdges(match)): Alignment {
  if (!match.profile.signals.enabled) return { offset: null, why: NO_ENABLED_SIGNAL }
  return align(edgesOf(reading.enable), edges, reading.enable.some((e) => e.on))
}

/**
 * The report with the experimental rules run again on this match with these readings attached (`match.hoot` set). The
 * rest of the report is the same objects: no robot-log finding, skip or count changes. An empty list still attaches
 * (the rules then say no .hoot was read).
 */
export function attachHoot(match: Match, report: Report, readings: HootReading[]): Report {
  const edges = logEnableEdges(match)
  match.hoot = readings.map((reading) => ({ reading, alignment: alignTo(match, reading, edges) }))
  return withExperimental(match, report)
}
