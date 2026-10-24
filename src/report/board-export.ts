/**
 * What "Download for Claude" adds beyond the findings (ADR 5): per issue, what the team recorded on the board, and per
 * rule, the public pages and numbers it stands on. Both are added only when there is something to add, so a file made
 * without a history differs from before only by the per-rule `rules` block.
 *
 * Roles only: a line's device id and anything like a name never go in. Pure, and free of the version module (plain-node
 * scripts reach this through findings-json).
 */
import { makerOf } from '../rules/index.ts'
import type { Source, Threshold } from '../rules/rule.ts'
import { boardKey, type BoardState, type CauseState } from '../triage/history.ts'
import { inScope, type Scope } from '../board/model.ts'

/** The board lines of an export: the folded states and the robot a log's findings are filed under. */
/** `scope` is the event the file is about (the board's own: `scopeOf(session)`; for one log its event and played time): a deferral belongs to an event and is carried only inside it. */
export interface ExportBoard { states: Map<string, BoardState>; robot: string; scope: Scope }

export interface IssueBoardJson {
  priority?: string
  status?: string
  deferred?: { until?: unknown; workaround: string | null; role: string; since: string }
  workaround?: string
  owner?: string
  notes?: { text: string; role: string; match?: string; since: string }[]
  causes?: { id: string; cause: string; state: CauseState; test?: string; text: string; role: string; since: string }[]
}

/** The board state of one issue as the export carries it, or null when the team recorded nothing on it. Roles only. */
export function issueBoardJson(state: BoardState | undefined, rule: string, scope: Scope): IssueBoardJson | null {
  if (!state) return null
  const names = new Map((makerOf(rule)?.causes ?? []).map((c) => [c.id, c.cause]))
  const out: IssueBoardJson = {}
  if (state.priority) out.priority = state.priority
  if (state.status) out.status = state.status
  // Scoped like the board: a deferral is about one event's matches. Priority, status, owner, notes and cause states carry as the board carries them. Queue ticks are not carried.
  const deferred = state.deferred && inScope(state.deferred, scope) ? state.deferred : undefined
  if (deferred) out.deferred = { ...(deferred.until ? { until: deferred.until } : {}), workaround: state.workaround ?? null, role: deferred.by.role, since: deferred.when }
  // A workaround belongs to its deferral: with a deferral out of scope it is left out too.
  if (state.workaround && !state.deferred) out.workaround = state.workaround
  if (state.owner) out.owner = state.owner
  if (state.notes.length) out.notes = state.notes.map((n) => ({ text: n.text, role: n.by.role, ...(n.match ? { match: n.match } : {}), since: n.when }))
  const causes = Object.entries(state.causes ?? {})
  if (causes.length) out.causes = causes.map(([id, c]) => ({ id, cause: names.get(id) ?? id, state: c.state, ...(c.test ? { test: c.test } : {}), text: c.text, role: c.by.role, since: c.when }))
  return Object.keys(out).length ? out : null
}

/** `{ board }` to spread into a finding's entry, or nothing. */
export function boardEntry(board: Pick<ExportBoard, 'states' | 'scope'> | undefined, key: string, rule: string, robot: string): { board?: IssueBoardJson } {
  const b = board ? issueBoardJson(board.states.get(boardKey(key, robot)), rule, board.scope) : null
  return b ? { board: b } : {}
}

export interface RuleJson { title: string; sources: Source[]; thresholds?: Threshold[] }

/** For each rule that made a finding (a group's finding has no sources of its own): its title, public sources and thresholds. */
export function ruleSources(rules: Iterable<string>): Record<string, RuleJson> {
  const out: Record<string, RuleJson> = {}
  for (const id of rules) {
    if (out[id]) continue
    const m = makerOf(id)
    if (!m || !('sources' in m)) continue
    out[id] = { title: m.title, sources: m.sources, ...(m.thresholds?.length ? { thresholds: m.thresholds } : {}) }
  }
  return out
}

/** What a file holds, counted for the "what's inside" list shown before saving (ADR 5). Reads the built JSON, so it cannot disagree with it. */
export interface ExportContents {
  /** A session file: its matches. */
  matches: number
  /** Findings without the "rules not checked" note, which is counted apart. */
  findings: number
  /** Rules the log could not check (the `meta/not-checked` finding's count). */
  notChecked: number
  /** Findings with a data window, and the series and points in them. */
  windows: number
  series: number
  points: number
  /** Issues with board state, and how many notes and cause states they carry. */
  boardIssues: number
  notes: number
  causeStates: number
  rules: number
}

export function exportContents(json: object): ExportContents {
  const j = json as { findings?: any[]; parents?: any[]; rules?: object; matches?: unknown[]; notChecked?: unknown[] }
  const real = (j.findings ?? []).filter((f) => f.rule !== 'meta/not-checked')
  const hasNote = real.length < (j.findings ?? []).length
  const all = [...real, ...(j.parents ?? [])]
  const windows = all.filter((f) => f.window)
  const series = windows.flatMap((f) => f.window.series as { t: number[] }[])
  return {
    matches: (j.matches ?? []).length,
    findings: real.length,
    notChecked: hasNote ? (j.notChecked ?? []).length : 0,
    windows: windows.length,
    series: series.length,
    points: series.reduce((n, s) => n + s.t.length, 0),
    boardIssues: all.filter((f) => f.board).length,
    notes: all.reduce((n, f) => n + (f.board?.notes?.length ?? 0), 0),
    causeStates: all.reduce((n, f) => n + (f.board?.causes?.length ?? 0), 0),
    rules: Object.keys(j.rules ?? {}).length,
  }
}

/** The list the student reads before saving, one line each. Says what is not inside as well. */
/** `bytes`: the file's size in bytes (UTF-8), not its length in characters. */
export function contentsLines(c: ExportContents, bytes: number): string[] {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  return [
    ...(c.matches ? [`${n(c.matches, 'match', 'matches')}, each with its summary numbers, and the table of which rules fired`] : []),
    `${n(c.findings, 'finding')}, each with its evidence numbers${c.notChecked ? `; ${n(c.notChecked, 'rule')} not checked` : ''}`,
    ...(c.matches ? [] : [c.windows ? `${n(c.windows, 'data window')} (${n(c.series, 'signal')}, ${n(c.points, 'point')}, thinned to at most 300 each)` : 'No data windows']),
    `Board records on ${n(c.boardIssues, 'issue')}: ${n(c.notes, 'note')}, ${n(c.causeStates, 'cause state')}`,
    `${c.rules} ${c.rules === 1 ? 'rule with its' : 'rules with their'} public sources and thresholds`,
    `About ${bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`}`,
    'No names added by Hindsight: board lines carry a role (pit, software, drive or mentor), never a person. Your own notes go in as you wrote them. Never the Wi-Fi key hash.',
  ]
}
