/**
 * From dropped files to reports: read each .wpilog, line up any .dslog with the match it overlaps, run the rules.
 * Used by the app (App.svelte), the command-line check (scripts/check.ts) and the tests.
 */

import { openWpilog } from './readers/wpilog.ts'
import { readDslog, type DslogFile } from './readers/dslog.ts'
import { parseHistory, type HistoryEvent } from './triage/history.ts'
import { attachDslog, buildMatch, dslogOverlap, type Match } from './match/match.ts'
import { runRules, type Report } from './rules/index.ts'
import { PROFILES } from './profiles/index.ts'
import { chooseProfile } from './profiles/choose.ts'
import type { RobotProfile } from './profiles/types.ts'

export interface InputFile { name: string; bytes: Uint8Array }

export interface Analysis {
  match: Match
  report: Report
  timing: { parseMs: number; rulesMs: number }
}

export interface AnalyzeResult {
  analyses: Analysis[]
  /** Files that couldn't be read, or DS logs that matched no robot log. */
  problems: string[]
  /** Known-issue and pit-check events from any hindsight-history.jsonl files dropped in. */
  history: HistoryEvent[]
}

/**
 * `profile`: the profile to use as is (a test or script pins one), or, per file name, the one the student chose
 * (checked for fit). Logs without one get the profile that fits them (profiles/choose.ts).
 */
export function analyzeFiles(files: InputFile[], profile?: RobotProfile | ((fileName: string) => RobotProfile | undefined)): AnalyzeResult {
  const problems: string[] = []
  const analyses: Analysis[] = []
  const dslogs: { name: string; file: DslogFile }[] = []
  const history: HistoryEvent[] = []
  for (const f of files) {
    const kind = fileKind(f)
    try {
      if (kind === 'wpilog') {
        const started = performance.now()
        const log = openWpilog(f.bytes)
        // A profile passed in directly (a test or script pins it) is used as is; the student's choice is checked for fit.
        const picked = typeof profile === 'object' ? { profile, choice: { how: 'given' as const, note: null, fit: null } } : chooseProfile(log, PROFILES, profile?.(f.name))
        const match = buildMatch(f.name, log, picked.profile, picked.choice)
        analyses.push({ match, report: { findings: [], skipped: [], crashed: [] }, timing: { parseMs: performance.now() - started, rulesMs: 0 } })
      } else if (kind === 'dslog') {
        dslogs.push({ name: f.name, file: readDslog(f.bytes) })
      } else if (kind === 'history') {
        const read = parseHistory(new TextDecoder().decode(f.bytes))
        history.push(...read.events)
        if (read.skipped) problems.push(`${f.name}: ${read.skipped} line${read.skipped === 1 ? '' : 's'} not understood (skipped)`)
      } else {
        problems.push(`${f.name}: not a .wpilog, .dslog or ${'hindsight-history.jsonl'} (skipped)`)
      }
    } catch (error) {
      problems.push(`${f.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Each DS log goes to the match it covers most of. One that covers no match window is reported, not guessed.
  for (const ds of dslogs) {
    const best = analyses
      .map((a) => ({ a, seconds: dslogOverlap(a.match, ds.file) }))
      .sort((x, y) => y.seconds - x.seconds)[0]
    if (best && best.seconds > 0) attachDslog(best.a.match, ds.file, ds.name)
    else problems.push(`${ds.name}: doesn't overlap any loaded match (it is from a different match, or the robot clock was never set)`)
  }
  for (const a of analyses) {
    const started = performance.now()
    a.report = runRules(a.match)
    a.timing.rulesMs = performance.now() - started
  }
  // Oldest match first (by the robot's wall clock when known, else by file name).
  const when = (a: Analysis) => (a.match.epochOffset ?? 0) + (a.match.matchStart ?? 0)
  analyses.sort((a, b) => when(a) - when(b) || a.match.fileName.localeCompare(b.match.fileName))
  return { analyses, problems, history }
}

/** Shorthand for scripts and tests: the analyses only. */
export function analyze(files: InputFile[], profile?: Parameters<typeof analyzeFiles>[1]): Analysis[] {
  return analyzeFiles(files, profile).analyses
}

function fileKind(f: InputFile): 'wpilog' | 'dslog' | 'history' | 'other' {
  const head = new TextDecoder().decode(f.bytes.subarray(0, 6))
  if (head === 'WPILOG') return 'wpilog'
  if (/\.dslog$/i.test(f.name)) return 'dslog'
  if (/\.jsonl$/i.test(f.name)) return 'history'
  return 'other'
}
