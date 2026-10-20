/**
 * Sessions: related matches looked at together (an event, a practice day), with how confident we can be in each
 * finding across them.
 *
 * Grouping: matches on the field (FMS) with the same event name within 4 days are one event (when the Driver Station
 * logged no event name, on-field matches within 4 days of each other are one event); everything else is grouped by
 * the local date it was played (a practice day). One match recorded in several logs (the robot program restarted
 * during it) counts once. The student can move a log or rename a session.
 *
 * Confidence of a finding across a session, from k = matches where it fired and n = matches where it could be checked:
 *   consistent:      fired in most (more than half) and n ≥ 3
 *   intermittent:    fired in 2 or more, but not most (or too few matches to call it consistent)
 *   once:            fired in exactly 1
 *   not enough data: fewer than 2 matches could be checked
 * The rate comes with a 95 % Wilson interval, and with how far past its threshold the measured value sat.
 */

import { joinPieces, type MatchSummary, type RuleStatus } from './summary.ts'
import { RULES } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import type { SummaryFinding } from './summary.ts'
import { median } from '../match/series.ts'

export interface Session {
  id: string
  label: string
  kind: 'event' | 'practice' | 'undated'
  matches: MatchSummary[]
}

const DAY = 86400e3

/**
 * Group summaries into sessions. `overrides` maps a file name to the label of the session the student moved it to:
 * an existing session with that label if there is one, else a new one. `renames` maps a session id to a new label.
 */
export function groupSessions(summaries: MatchSummary[], overrides: Record<string, string> = {}, renames: Record<string, string> = {}): Session[] {
  const sorted = joinSplitMatches([...summaries].sort((a, b) => (a.playedAt ?? Infinity) - (b.playedAt ?? Infinity) || a.fileName.localeCompare(b.fileName)))
  const sessions: Session[] = []
  const byId = new Map<string, Session>()
  const add = (id: string, label: string, kind: Session['kind'], m: MatchSummary) => {
    let s = byId.get(id)
    if (!s) { s = { id, label: renames[id] ?? label, kind, matches: [] }; byId.set(id, s); sessions.push(s) }
    s.matches.push(m)
  }
  // Automatic grouping first, for every log the student hasn't moved.
  for (const m of sorted) {
    if (overrides[m.fileName]) continue
    if (m.playedAt === null) { add('undated', 'Logs with no date', 'undated', m); continue }
    if (m.onField) {
      // Same event name within 4 days of the event's last match: the same event. The id is the event name and its
      // first day, so a rename survives adding more logs from that day.
      const open = sessions.find((s) => s.kind === 'event' && s.id.startsWith(`event:${m.event}:`) && m.playedAt! - (s.matches.at(-1)!.playedAt ?? 0) < 4 * DAY)
      if (open) { open.matches.push(m); continue }
      const day = dateText(m.playedAt)
      add(`event:${m.event}:${day}`, m.event ? `Event ${m.event} (${day})` : `Event starting ${day} (no event name logged)`, 'event', m)
      continue
    }
    const day = dateText(m.playedAt)
    add(`practice:${day}`, `Practice ${day}`, 'practice', m)
  }
  // Then the logs the student moved: into the session with that label if it exists, else a new one.
  for (const m of sorted) {
    const label = overrides[m.fileName]
    if (!label) continue
    const target = sessions.find((s) => s.label === label)
    if (target) {
      target.matches.push(m)
      target.matches.sort((a, b) => (a.playedAt ?? Infinity) - (b.playedAt ?? Infinity))
    } else add(`manual:${label}`, label, 'practice', m)
  }
  return sessions
}

/**
 * Logs of the same on-field match (same event and match label, each starting within 30 minutes of the last) are one
 * match: the robot program restarted during it. A piece without auto is dated by its log start, which can be 12
 * minutes before the match at a real event (robot on the field, waiting); a replay of the same label is hours later.
 * `summaries` must be sorted by time.
 */
export function joinSplitMatches(summaries: MatchSummary[]): MatchSummary[] {
  const out: MatchSummary[][] = []
  for (const m of summaries) {
    const prev = out.at(-1)?.at(-1)
    const same = prev && m.onField && prev.onField && m.matchLabel && m.matchLabel === prev.matchLabel && m.event === prev.event
      && m.playedAt !== null && prev.playedAt !== null && m.playedAt - prev.playedAt < 30 * 60e3
    if (same) out.at(-1)!.push(m)
    else out.push([m])
  }
  return out.map(joinPieces)
}

/** Local calendar date, YYYY-MM-DD. */
export function dateText(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export type Confidence = 'consistent' | 'intermittent' | 'once' | 'not enough data' | 'quiet'

export interface RuleRow {
  rule: string
  title: string
  /** One status per match, in session order. */
  cells: RuleStatus[]
  fired: number
  checkable: number
  confidence: Confidence
  /** 95 % Wilson interval for the firing rate. */
  interval: [number, number]
}

/** Wilson score interval for k successes in n trials (z = 1.96). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1]
  const p = k / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

export function confidence(fired: number, checkable: number): Confidence {
  if (checkable < 2) return 'not enough data'
  if (fired === 0) return 'quiet'
  if (fired === 1) return 'once'
  if (checkable >= 3 && fired / checkable > 0.5) return 'consistent'
  return 'intermittent'
}

export const CONFIDENCE_WORDS: Record<Confidence, string> = {
  consistent: 'Consistent',
  intermittent: 'Intermittent',
  once: 'Once',
  'not enough data': 'Not enough data',
  quiet: 'Quiet',
}

/** The rule × match grid for a session. */
export function ruleGrid(session: Session): RuleRow[] {
  return RULES.map((rule) => {
    const cells = session.matches.map((m) => m.rules[rule.id]?.status ?? 'not checked')
    const fired = cells.filter((c) => c === 'fired').length
    const checkable = cells.filter((c) => c !== 'not checked').length
    return { rule: rule.id, title: rule.title, cells, fired, checkable, confidence: confidence(fired, checkable), interval: wilson(fired, checkable) }
  })
}

export interface MergedFinding {
  /** The issue's identity (rule · what it is about), the same key known-issue tracking uses. */
  key: string
  rule: string
  severity: Finding['severity']
  /** The latest match's wording. */
  title: string
  /** Matches it fired in, by index into session.matches. */
  matches: number[]
  checkable: number
  confidence: Confidence
  interval: [number, number]
  /** Per measured quantity: the range across matches, and how far past the threshold (as a fraction) at the median. */
  measured: { label: string; unit: string; min: number; max: number; threshold?: number; medianMargin?: number }[]
  /**
   * The team's marks (triage/track-record.ts sessionWithMarks), only when there are some: the matches (by index into
   * session.matches) where it was marked "not a real problem", and the wrong mark on another match of the event that
   * turned its reds amber (the newest, when there are several).
   */
  wrong?: { match: number; reason: string; when: string }[]
  demoted?: Finding['demoted']
}

/** The same finding across matches (by key), worst first. */
export function mergeFindings(session: Session): MergedFinding[] {
  const byKey = new Map<string, { f: SummaryFinding[]; idx: number[] }>()
  const wrongIn = new Map<string, NonNullable<MergedFinding['wrong']>>()
  session.matches.forEach((m, i) => {
    for (const r of Object.values(m.rules)) {
      // Grey (info) findings are context, not something that fired in the match.
      for (const f of r.findings.filter((x) => x.severity !== 'info')) {
        const e = byKey.get(f.key) ?? { f: [], idx: [] }
        e.f.push(f)
        if (!e.idx.includes(i)) e.idx.push(i)
        byKey.set(f.key, e)
        const w = wrongIn.get(f.key) ?? []
        if (f.wrongMark && !w.some((x) => x.match === i)) wrongIn.set(f.key, [...w, { match: i, ...f.wrongMark }])
      }
    }
  })
  const order = { error: 0, warning: 1, info: 2 }
  const out: MergedFinding[] = []
  for (const [key, { f, idx }] of byKey) {
    const rule = f[0].rule
    const checkable = session.matches.filter((m) => (m.rules[rule]?.status ?? 'not checked') !== 'not checked').length
    // A match where it was marked not a real problem doesn't make it more serious, unless every match was.
    const counted = f.some((x) => !x.wrongMark) ? f.filter((x) => !x.wrongMark) : f
    const worst = counted.reduce((a, b) => (order[b.severity] < order[a.severity] ? b : a))
    const labels = [...new Set(f.flatMap((x) => (x.measured ?? []).map((m) => m.label)))]
    const measured = labels.flatMap((label) => {
      const vals = f.flatMap((x) => (x.measured ?? []).filter((m) => m.label === label && Number.isFinite(m.value)))
      if (vals.length === 0) return []
      const threshold = vals.find((v) => v.threshold !== undefined)?.threshold
      const margins = threshold ? vals.map((v) => Math.abs(v.value - threshold) / Math.abs(threshold)) : []
      return [{
        label, unit: vals[0].unit,
        min: Math.min(...vals.map((v) => v.value)), max: Math.max(...vals.map((v) => v.value)),
        threshold, medianMargin: margins.length ? median(margins) : undefined,
      }]
    })
    const demoted = f.map((x) => x.demoted).filter((d) => !!d).sort((a, b) => a.when.localeCompare(b.when)).at(-1)
    out.push({
      key, rule, severity: worst.severity, title: f[f.length - 1].title,
      matches: idx, checkable, confidence: confidence(idx.length, checkable), interval: wilson(idx.length, checkable), measured,
      ...(wrongIn.has(key) ? { wrong: wrongIn.get(key) } : {}), ...(demoted ? { demoted } : {}),
    })
  }
  const place = (r: string) => RULES.findIndex((x) => x.id === r)
  return out.sort((a, b) => order[a.severity] - order[b.severity] || b.matches.length - a.matches.length || place(a.rule) - place(b.rule))
}

/**
 * Issue keys that fired in EVERY match of the session where they could be checked, with at least 3 such matches:
 * stricter than "consistent" (more than half), so "in every match this event" is literally true. A rule that ran only
 * partly counts as checkable (the same test as mergeFindings and the grid). Grey (info) findings never count.
 */
export function standingKeys(session: Session): Set<string> {
  return new Set(mergeFindings(session).filter((f) => f.checkable >= 3 && f.matches.length === f.checkable).map((f) => f.key))
}

/** "fired in 5 of 7 matches where it could be checked" */
export function rateText(fired: number, checkable: number): string {
  return `fired in ${fired} of ${checkable} match${checkable === 1 ? '' : 'es'} where it could be checked`
}
