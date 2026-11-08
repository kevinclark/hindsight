/**
 * From dropped files to reports: read each .wpilog, line up any .dslog and .dsevents with the match it overlaps, run
 * the rules.
 * Used by the app (App.svelte), the command-line check (scripts/check.ts) and the tests.
 */

import { openWpilog } from './readers/wpilog.ts'
import { readDslog, type DslogFile } from './readers/dslog.ts'
import { readDsevents, type DseventsFile } from './readers/dsevents.ts'
import { parseHistory, type HistoryEvent } from './triage/history.ts'
import { powerMapAt, powerMapStamp } from './power/power-map.ts'
import { attachDsevents, attachDslog, buildMatch, dseventsOverlap, dslogOverlap, type Match } from './match/match.ts'
import { CONSOLIDATORS, RULES, runRules, type Report } from './rules/index.ts'
import { rerunRules } from './rules/run.ts'
import { PROFILES, mapRobotIds } from './profiles/index.ts'
import { chooseProfile } from './profiles/choose.ts'
import type { RobotProfile } from './profiles/types.ts'
import type { PowerMap } from './power/power-map.ts'
import { compareMatchLimits, type CodeFolder } from './code/limit-lines.ts'

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
 * (checked for fit). Logs without one get the profile that fits them (profiles/choose.ts) from `profiles`: the
 * built-in ones, plus any the page passes in (profiles kept in this browser, src/builder/store.ts).
 * `history`: the team's history lines, read for the robot's power map (each match gets the map in effect when it was
 * played, for the breaker rules); lines from dropped-in history files count too. `AnalyzeResult.history` stays only
 * what the dropped files held.
 */
export function analyzeFiles(files: InputFile[], profile?: ProfileChoice, profiles: RobotProfile[] = PROFILES, history: HistoryEvent[] = []): AnalyzeResult {
  return runAll(openFiles(files, profile, profiles), history)
}

/**
 * The same, with the robot-code folder: before the rules run, each log that ran another commit than its profile's has
 * its current-limit lines compared with the profile's commit (src/code/limit-lines.ts). No folder: as analyzeFiles.
 */
export async function analyzeFilesWithCode(files: InputFile[], code: CodeFolder | null, profile?: ProfileChoice, profiles: RobotProfile[] = PROFILES, history: HistoryEvent[] = []): Promise<AnalyzeResult> {
  const opened = openFiles(files, profile, profiles)
  if (code) for (const a of opened.analyses) await compareMatchLimits(a.match, code)
  return runAll(opened, history)
}

type ProfileChoice = RobotProfile | ((fileName: string) => RobotProfile | undefined)

/** Read every file and build each match, with its DS logs attached; no rules run yet. */
function openFiles(files: InputFile[], profile: ProfileChoice | undefined, profiles: RobotProfile[]): AnalyzeResult {
  const problems: string[] = []
  const analyses: Analysis[] = []
  const dslogs: { name: string; file: DslogFile }[] = []
  const dsevents: { name: string; file: DseventsFile }[] = []
  const history: HistoryEvent[] = []
  for (const f of files) {
    const kind = fileKind(f)
    try {
      if (kind === 'wpilog') {
        const started = performance.now()
        const log = openWpilog(f.bytes)
        // A profile passed in directly (a test or script pins it) is used as is; the student's choice is checked for fit.
        const picked = typeof profile === 'object' ? { profile, choice: { how: 'given' as const, note: null, fit: null } } : chooseProfile(log, profiles, profile?.(f.name))
        const match = buildMatch(f.name, log, picked.profile, picked.choice)
        analyses.push({ match, report: { findings: [], skipped: [], crashed: [] }, timing: { parseMs: performance.now() - started, rulesMs: 0 } })
      } else if (kind === 'dslog') {
        dslogs.push({ name: f.name, file: readDslog(f.bytes) })
      } else if (kind === 'dsevents') {
        dsevents.push({ name: f.name, file: readDsevents(f.bytes) })
      } else if (kind === 'history') {
        const read = parseHistory(new TextDecoder().decode(f.bytes))
        history.push(...read.events)
        if (read.skipped) problems.push(`${f.name}: ${read.skipped} line${read.skipped === 1 ? '' : 's'} not understood (skipped)`)
      } else {
        problems.push(`${f.name}: not a .wpilog, .dslog, .dsevents or ${'hindsight-history.jsonl'} (skipped)`)
      }
    } catch (error) {
      problems.push(`${f.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Each DS file goes to the match it covers most of. One that covers no match window is reported, not guessed.
  type Attach<F> = { kind: { name: string; file: F }[]; overlap: (m: Match, f: F) => number; add: (m: Match, f: F, n: string) => void }
  const attach = <F>({ kind, overlap, add }: Attach<F>) => {
    for (const ds of kind) {
      const best = analyses.map((a) => ({ a, seconds: overlap(a.match, ds.file) })).sort((x, y) => y.seconds - x.seconds)[0]
      if (best && best.seconds > 0) add(best.a.match, ds.file, ds.name)
      else problems.push(`${ds.name}: doesn't overlap any loaded match (it is from a different match, or the robot clock was never set)`)
    }
  }
  attach({ kind: dslogs, overlap: dslogOverlap, add: attachDslog })
  attach({ kind: dsevents, overlap: dseventsOverlap, add: attachDsevents })
  return { analyses, problems, history }
}

/** Run the rules on every opened match, oldest match first. */
function runAll({ analyses, problems, history }: AnalyzeResult, given: HistoryEvent[] = []): AnalyzeResult {
  const known = [...given, ...history]
  for (const a of analyses) a.match.powerMap = powerMapFor(a.match, known)
  // Rules can look across the logs loaded together (a match recorded in pieces, earlier runs of an auto).
  for (const a of analyses) a.match.others = analyses.map((x) => x.match).filter((m) => m !== a.match)
  for (const a of analyses) {
    const started = performance.now()
    a.report = runRules(a.match, RULES, CONSOLIDATORS)
    a.timing.rulesMs = performance.now() - started
  }
  // Oldest match first (by the robot's wall clock when known, else by file name).
  const when = (a: Analysis) => (a.match.epochOffset ?? 0) + (a.match.matchStart ?? 0)
  analyses.sort((a, b) => when(a) - when(b) || a.match.fileName.localeCompare(b.match.fileName))
  return { analyses, problems, history }
}

/** Robot clocks before this are unset (as MatchView.wallClock reads them). */
const EARLIEST_PLAUSIBLE_EPOCH = Date.UTC(2023, 0, 1) / 1000

/** The instant a match's power map is looked up at: its wall-clock start when the robot's clock was set, else "latest" (a far-off instant). */
export function powerMapInstant(match: Match): string {
  const start = match.matchStart ?? match.runs[0]?.start ?? match.logStart
  const epoch = match.epochOffset === null ? null : match.epochOffset + start
  return epoch !== null && epoch >= EARLIEST_PLAUSIBLE_EPOCH ? new Date(epoch * 1000).toISOString() : LATEST
}
const LATEST = '9999-12-31T23:59:59.999Z'

/**
 * The power map in effect when the match was played: at its wall-clock start when the robot's clock was set, else (no
 * clock to place it) the robot's latest map.
 */
function powerMapFor(match: Match, history: HistoryEvent[]): PowerMap | null {
  return powerMapAt(history, mapRobotIds(match.profile), powerMapInstant(match))
}

/** The rules that read the power map, and nothing else does. */
const BREAKER_RULES = RULES.filter((r) => r.id === 'power/main-breaker-margin' || r.id === 'power/pdp-breaker-margin')

/**
 * The open analyses after the team's history changed: each match whose effective power map is no longer the one it was
 * judged with has the two breaker rules run again on the same match (no re-parse). Null when no map changed, so a
 * caller keeps what it has; otherwise a new list in which unchanged analyses are the same objects.
 */
export function withPowerMaps(analyses: Analysis[], history: HistoryEvent[]): Analysis[] | null {
  let changed = false
  const next = analyses.map((a) => {
    const map = powerMapFor(a.match, history)
    if (powerMapStamp(map) === powerMapStamp(a.match.powerMap)) return a
    changed = true
    a.match.powerMap = map // in place: other matches name this one in `others`
    const started = performance.now()
    const report = rerunRules(a.match, a.report, BREAKER_RULES, RULES)
    return { ...a, report, timing: { ...a.timing, rulesMs: a.timing.rulesMs + performance.now() - started } }
  })
  return changed ? next : null
}

/** Shorthand for scripts and tests: the analyses only. */
export function analyze(files: InputFile[], profile?: Parameters<typeof analyzeFiles>[1]): Analysis[] {
  return analyzeFiles(files, profile).analyses
}

function fileKind(f: InputFile): 'wpilog' | 'dslog' | 'dsevents' | 'history' | 'other' {
  const head = new TextDecoder().decode(f.bytes.subarray(0, 6))
  if (head === 'WPILOG') return 'wpilog'
  if (/\.dslog$/i.test(f.name)) return 'dslog'
  if (/\.dsevents$/i.test(f.name)) return 'dsevents'
  if (/\.jsonl$/i.test(f.name)) return 'history'
  return 'other'
}
