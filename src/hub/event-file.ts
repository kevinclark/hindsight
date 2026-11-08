/**
 * One event's match summaries, as each laptop publishes them for the phone: `events/<TBA event key>--<machine id>.jsonl`,
 * flat in one `events/` folder (a folder per event would bring back Drive's create-if-absent race when two laptops start one
 * at once). One writer per file, append-only, through the adapters' `appendManifest`, the rule manifests and history follow.
 *
 * A line is one log's summary as one build of the analyzer read it: `{sha256, analyzer, shape, at, summary}`. The summary
 * carries no marks (a summary must not bake in stale triage): the team's marks travel in history/ and are laid over on the
 * phone, as on a laptop. Meaning, causes and next step are the rule's own text, which the phone has in its code.
 *
 * No `node:` imports and nothing from the analyzer: the main process, the page and the phone all use this file.
 */
import { newerVersion } from './catalog.ts'
import type { MatchSummary } from '../session/summary.ts'

/** The Blue Alliance's event key: the year and the event's code ("2026cacg"). No "-", so the first "--" in a file name ends it. */
export const EVENT_KEY = /^\d{4}[a-z0-9]{1,16}$/
const MACHINE = /^[A-Za-z0-9_-]+$/

export const isEventKey = (key: unknown): key is string => typeof key === 'string' && EVENT_KEY.test(key)

export function eventFilePath(key: string, machine: string): string {
  if (!isEventKey(key)) throw new Error(`not an event key: ${JSON.stringify(key)}`)
  if (!MACHINE.test(machine)) throw new Error(`not a machine id: ${JSON.stringify(machine)}`)
  return `events/${key}--${machine}.jsonl`
}

/** The event and the laptop an event file is for, or null for any other path. */
export function parseEventPath(path: string): { key: string; machine: string } | null {
  const m = /^events\/(\d{4}[a-z0-9]{1,16})--([A-Za-z0-9_-]+)\.jsonl$/.exec(path)
  return m ? { key: m[1], machine: m[2] } : null
}

export interface EventLine {
  /** The log's sha-256 (the library's identity for it). */
  sha256: string
  /** Which build of the analyzer read it, and with what: "<app version>+<hash>" (analyzerId). */
  analyzer: string
  /** The summary's SUMMARY_SHAPE: a phone draws only the shape its code knows. */
  shape: number
  /** When the line was written (ms since 1970): breaks a tie between two lines of the same version. */
  at: number
  summary: MatchSummary
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A line from a teammate's file is untrusted input: only lines of the right shape are kept. */
export function isEventLine(v: unknown): v is EventLine {
  if (!isObject(v)) return false
  const s = v.summary
  return typeof v.sha256 === 'string' && /^[0-9a-f]{64}$/.test(v.sha256) && typeof v.analyzer === 'string' && v.analyzer.length > 0 && v.analyzer.length < 200
    && Number.isInteger(v.shape) && typeof v.at === 'number' && Number.isFinite(v.at)
    && isObject(s) && typeof s.fileName === 'string' && isObject(s.rules) && isObject(s.metrics) && isObject(s.robot)
}

export function parseEventLines(text: string): { lines: EventLine[]; skipped: number } {
  const lines: EventLine[] = []
  let skipped = 0
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    try {
      const v = JSON.parse(raw) as unknown
      if (isEventLine(v)) lines.push(v); else skipped++
    } catch { skipped++ }
  }
  return { lines, skipped }
}

/** The summary as it is published: every mark the team's history laid over a finding is taken off. */
export function withoutMarks(summary: MatchSummary): MatchSummary {
  const rules: MatchSummary['rules'] = {}
  for (const [id, r] of Object.entries(summary.rules)) rules[id] = { ...r, findings: r.findings.map(({ wrongMark: _w, demoted: _d, ...f }) => f) }
  return { ...summary, rules }
}

export const serializeEventLine = (line: EventLine): string => `${JSON.stringify(line)}\n`

/** The analyzer's own hash, without the app version: CI stamps a new version on every release (0.1.<commit count>). */
export const analyzerHashOf = (analyzer: string): string => analyzer.slice(analyzer.indexOf('+') + 1)

/** The (log, analyzer hash) pairs a file already holds: a log is written once per analyzer, whatever release carried it. */
const pairOf = (l: Pick<EventLine, 'sha256' | 'analyzer'>) => `${l.sha256} ${analyzerHashOf(l.analyzer)}`

/** Of `candidates`, the lines whose (log, analyzer hash) `existing` lacks, each pair once, in the order given. */
export function freshLines(existing: readonly EventLine[], candidates: readonly EventLine[]): EventLine[] {
  const have = new Set(existing.map(pairOf))
  const out: EventLine[] = []
  for (const c of candidates) {
    if (have.has(pairOf(c))) continue
    have.add(pairOf(c))
    out.push(c)
  }
  return out
}

/** FNV-1a, 32 bits, as 8 hex digits: an identity for a set of inputs, not a security check (the page has no sync sha-256). */
export function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/**
 * "<app version>+<hash>", the hash over the analyzer's own source (what the rules and summary import: `__ANALYZER_HASH__`), the
 * robot profile the log was read with, and whether a code folder was used: two laptops with different kept profiles read a
 * log differently. The version orders lines on the phone; only the hash decides whether a line is new (freshLines), so a
 * release that changes only the UI keeps the hash and appends nothing.
 */
export function analyzerId(version: string, analyzerHash: string, profileId: string, codeFolder: boolean): string {
  return `${version}+${shortHash(`${analyzerHash}|${profileId}|${codeFolder ? 'code' : 'no code'}`)}`
}

export interface FoldedLine { line: EventLine; machine: string }

/**
 * The event as the phone shows it: for each log, the line read by the newest app version; on a tie, the later `at`, then
 * the later line (the catalog's rule for `meta` records). `files` in any order; each names the laptop it came from.
 */
export function foldEvent(files: readonly { machine: string; text: string }[]): { logs: Map<string, FoldedLine>; skipped: number } {
  const logs = new Map<string, FoldedLine>()
  let skipped = 0
  for (const f of [...files].sort((a, b) => a.machine.localeCompare(b.machine))) {
    const parsed = parseEventLines(f.text)
    skipped += parsed.skipped
    for (const line of parsed.lines) {
      const old = logs.get(line.sha256)
      if (!old || replaces(line, old.line)) logs.set(line.sha256, { line, machine: f.machine })
    }
  }
  return { logs, skipped }
}

function replaces(a: EventLine, b: EventLine): boolean {
  if (newerVersion(a.analyzer, b.analyzer)) return true
  if (newerVersion(b.analyzer, a.analyzer)) return false
  return a.at >= b.at
}
