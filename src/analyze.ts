/**
 * From dropped files to reports: read each .wpilog, line up any .dslog with the match it overlaps, run the rules.
 * Used by the app (App.svelte), the command-line check (scripts/check.ts) and the tests.
 */

import { openWpilog } from './readers/wpilog.ts'
import { readDslog, type DslogFile } from './readers/dslog.ts'
import { attachDslog, buildMatch, type Match } from './match/match.ts'
import { runRules, type Report } from './rules/index.ts'
import { offseason2026 } from './profiles/2026-offseason.ts'
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
}

export function analyzeFiles(files: InputFile[], profile: RobotProfile = offseason2026): AnalyzeResult {
  const problems: string[] = []
  const analyses: Analysis[] = []
  const dslogs: { name: string; file: DslogFile }[] = []
  for (const f of files) {
    const kind = fileKind(f)
    try {
      if (kind === 'wpilog') {
        const started = performance.now()
        const match = buildMatch(f.name, openWpilog(f.bytes), profile)
        analyses.push({ match, report: { findings: [], skipped: [], crashed: [], ruleMs: {} }, timing: { parseMs: performance.now() - started, rulesMs: 0 } })
      } else if (kind === 'dslog') {
        dslogs.push({ name: f.name, file: readDslog(f.bytes) })
      } else {
        problems.push(`${f.name}: not a .wpilog or .dslog (skipped)`)
      }
    } catch (error) {
      problems.push(`${f.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const ds of dslogs) {
    const owner = analyses.find((a) => attachDslog(a.match, ds.file, ds.name))
    if (!owner) problems.push(`${ds.name}: doesn't overlap any robot log loaded (it is from a different match)`)
  }
  for (const a of analyses) {
    const started = performance.now()
    a.report = runRules(a.match)
    a.timing.rulesMs = performance.now() - started
  }
  analyses.sort((a, b) => a.match.fileName.localeCompare(b.match.fileName))
  return { analyses, problems }
}

/** Shorthand for scripts and tests: the analyses only. */
export function analyze(files: InputFile[], profile: RobotProfile = offseason2026): Analysis[] {
  return analyzeFiles(files, profile).analyses
}

function fileKind(f: InputFile): 'wpilog' | 'dslog' | 'other' {
  const head = new TextDecoder().decode(f.bytes.subarray(0, 6))
  if (head === 'WPILOG') return 'wpilog'
  if (/\.dslog$/i.test(f.name)) return 'dslog'
  return 'other'
}
