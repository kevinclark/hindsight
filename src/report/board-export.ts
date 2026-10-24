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

/** The board lines of an export: the folded states and the robot a log's findings are filed under. */
export interface ExportBoard { states: Map<string, BoardState>; robot: string }

export interface IssueBoardJson {
  priority?: string
  status?: string
  deferred?: { until?: unknown; workaround: string | null; role: string; since: string }
  workaround?: string
  owner?: string
  notes?: { text: string; role: string; match?: string; since: string }[]
  causes?: { id: string; cause: string; state: CauseState; text: string; role: string; since: string }[]
  checked?: { match: string; role: string; since: string }[]
}

/** The board state of one issue as the export carries it, or null when the team recorded nothing on it. Roles only. */
export function issueBoardJson(state: BoardState | undefined, rule: string): IssueBoardJson | null {
  if (!state) return null
  const names = new Map((makerOf(rule)?.causes ?? []).map((c) => [c.id, c.cause]))
  const out: IssueBoardJson = {}
  if (state.priority) out.priority = state.priority
  if (state.status) out.status = state.status
  if (state.deferred) out.deferred = { ...(state.deferred.until ? { until: state.deferred.until } : {}), workaround: state.workaround ?? null, role: state.deferred.by.role, since: state.deferred.when }
  if (state.workaround && !state.deferred) out.workaround = state.workaround
  if (state.owner) out.owner = state.owner
  if (state.notes.length) out.notes = state.notes.map((n) => ({ text: n.text, role: n.by.role, ...(n.match ? { match: n.match } : {}), since: n.when }))
  const causes = Object.entries(state.causes ?? {})
  if (causes.length) out.causes = causes.map(([id, c]) => ({ id, cause: names.get(id) ?? id, state: c.state, text: c.text, role: c.by.role, since: c.when }))
  if (state.checked?.length) out.checked = state.checked.map((c) => ({ match: c.match, role: c.by.role, since: c.when }))
  return Object.keys(out).length ? out : null
}

/** `{ board }` to spread into a finding's entry, or nothing. */
export function boardEntry(board: Pick<ExportBoard, 'states'> | undefined, key: string, rule: string, robot: string): { board?: IssueBoardJson } {
  const b = board ? issueBoardJson(board.states.get(boardKey(key, robot)), rule) : null
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
  findings: number
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
  const j = json as { findings?: any[]; parents?: any[]; rules?: object; matches?: unknown[] }
  const all = [...(j.findings ?? []), ...(j.parents ?? [])]
  const windows = all.filter((f) => f.window)
  const series = windows.flatMap((f) => f.window.series as { t: number[] }[])
  return {
    matches: (j.matches ?? []).length,
    findings: (j.findings ?? []).length,
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
export function contentsLines(c: ExportContents, bytes: number): string[] {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  return [
    ...(c.matches ? [`${n(c.matches, 'match', 'matches')}, each with its summary numbers, and the table of which rules fired`] : []),
    `${n(c.findings, 'finding')}, each with its evidence numbers`,
    ...(c.matches ? [] : [`${n(c.windows, 'data window')} (${n(c.series, 'signal')}, ${n(c.points, 'point')}, thinned to at most 300 each)`]),
    `Board records on ${n(c.boardIssues, 'issue')}: ${n(c.notes, 'note')}, ${n(c.causeStates, 'cause state')}`,
    `${c.rules} ${c.rules === 1 ? 'rule with its' : 'rules with their'} public sources and thresholds`,
    `About ${bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`}`,
    'No names: the board lines carry a role (pit, software, drive or mentor), never a person. Never the Wi-Fi key hash.',
  ]
}
