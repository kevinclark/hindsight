/**
 * What the Session report and its phone card say, computed once from what the Session view already knows
 * (mergeFindings, ruleGrid, the same notes and the same "came back" test as SessionView). No layout here.
 *
 * Words are the app's: confidence in words (CONFIDENCE_WORDS), "N of M where it could be checked" with the 95 %
 * interval, and "line" for the rule's threshold, never "limit".
 */

import { PROFILE_FIT_MIN } from '../profiles/choose.ts'
import { VERSION } from '../version.ts'
import type { IssueEvent } from '../triage/history.ts'
import {
  CONFIDENCE_WORDS, dateText, mergeFindings, ruleGrid,
  type Confidence, type MergedFinding, type RuleRow, type Session,
} from '../session/session.ts'
import { SESSION_FINDINGS_SCHEMA } from '../session/export.ts'
import { sinks, stoppedCard, stoppedFiring, stoppedShort, stoppedText } from '../session/stopped.ts'
import { summaryRobot, type MatchSummary, type RuleStatus } from '../session/summary.ts'
import type { Severity } from '../rules/types.ts'
import { trendRows } from '../session/trends.ts'
import { titleHasValue } from './review-model.ts'
import type { CardModel, Tone } from './card.ts'
import { ruleById } from '../rules/index.ts'
import { cardTitle } from './titles.ts'
import { shortMatchLabel } from '../ui/match-label.ts'

const plural = (n: number, one: string, many = `${one}es`) => `${n} ${n === 1 ? one : many}`
export const pct = (x: number) => `${Math.round(100 * x)} %`
/** The 95 % interval as "44–100 %". */
export const interval = (i: [number, number]) => `${Math.round(100 * i[0])}–${pct(i[1])}`
/** At most 2 decimals, without trailing zeros: 7.4, 1.2–2.1, 53. */
export const fmt = (x: number) => String(+x.toFixed(Math.abs(x) >= 100 ? 0 : 2))
/** How far past the line, in words: "12 % past it", or "7.0× the line" when it is far past. */
export const past = (margin: number) => (margin < 1 ? `${pct(margin)} past it` : `${(1 + margin).toFixed(1)}× the line`)

/** A match as the view names it: its label (or file name), with the number of logs when it was split. */
export const matchLabel = (m: MatchSummary) => (m.matchLabel || m.fileName.replace(/\.wpilog$/i, '')) + (m.pieces ? ` (${m.pieces.length} logs)` : '')

const KIND_WORDS = { event: 'Event', practice: 'Practice day', undated: 'Logs with no date' } as const

export interface ReportFinding {
  key: string
  rule: string
  severity: 'error' | 'warning'
  /** "Error" / "Warning". */
  sevWord: string
  confidence: Confidence
  confidenceWord: string
  /** The rule's short name ("Loop overruns"), for the bottom line. */
  ruleTitle: string
  /** The latest match's wording, without its per-match "(teleop; robot time 417.4 s)" aside. */
  title: string
  /** "3 of 3". */
  ratio: string
  /** "fired in 3 of 3 where it could be checked (44–100 %)". */
  rateText: string
  /** "slowest follower 62–71 % (line 85 %, 12 % past it)", one per measured quantity, joined by "; ". */
  measured: string
  /** Matches played after a fix was recorded, where it fired again. */
  cameBack: string[]
  /** "Not seen since Q4 · 3 clean checked matches · …" or "Marked fixed after Q4 · …" (session/stopped.ts); empty when neither. */
  stopped: string
  /** Potentially fixed, and not an error: it sorts below the live findings, in the bottom line's "Stopped" group. */
  sinks: boolean
  /** "not seen since Q4, 1 in 35", for the bottom line; empty unless it sinks. */
  stoppedShort: string
  /** The card's stopped line (session/stopped.ts stoppedCard): potentially fixed, errors too, or a fixed mark; else empty. */
  cardStopped: string
  /** Potentially fixed, whatever its severity: the card's word says so. */
  potentiallyFixed: boolean
  /** Labels of the matches it fired in. */
  matchLabels: string[]
  /** The first measured quantity, for the card; empty when the title already says its number. */
  cardMeasured: string
  /** What the team's marks say about it (marksText); empty with none. */
  marks: string
  /** The matches where it was marked not a real problem ("Q4"), for the card. */
  wrongIn: string[]
}

export interface TrendPoint { /** The file name: unique even when two matches share a label (a replay). */ id: string; match: string; value: number; x: number; y: number; letter: string; worst: boolean }
export interface TrendPanel {
  key: string; label: string; unit: string
  /** The Session view's verdict for this number ("Under 7 V in 8 of 8 matches"). */
  verdict: string
  /** y of the rule's line, when it has one. */
  lineY: number | null
  points: TrendPoint[]
  /** "7.1–10.6", the scale shared by every match. */
  range: string
}
export interface Trends {
  width: number; height: number
  /** Space kept clear round the plot: the dots and the dashed line stay this far from the edge. */
  pad: number
  panels: TrendPanel[]
  /** One letter per battery, so identity never rests on colour. */
  batteries: { letter: string; id: string }[]
  /** Matches left to right, as labelled. */
  order: string[]
  /** A match with no battery ID gets no letter. */
  anyUnlabelled: boolean
}

export interface GridModel {
  /** One per match; `id` is the file name, since two matches can share a label. */
  columns: { id: string; label: string }[]
  rows: { rule: string; title: string; cells: RuleStatus[]; rate: string; firedAnywhere: boolean; marked: boolean[] }[]
}

/**
 * One cell of the rule × match grid: what the rule said in that match, its worst finding, and whether the team marked
 * every warning and error there "not a real problem" (the cell then keeps that severity's shape, greyed).
 */
export interface GridCell { status: RuleStatus; severity: Severity | null; marked: boolean }

export interface SessionModel {
  label: string
  kind: string
  dates: string
  matchCount: number
  /** The robot profiles the logs were read with, and the code each profile was read from ("" when it names none). */
  robots: { name: string; code: string; matches: number }[]
  /** The code the logs themselves say they ran (/RealMetadata), most matches first. */
  builds: { sha: string; branch: string; uncommitted: boolean; matches: number }[]
  /** Matches whose log says they ran uncommitted code, and how many logs say nothing about it. */
  uncommitted: number
  buildUnknown: number
  bottomLine: string
  /** Every merged error and warning, in the report's order, except `filed` (the bottom line, the card and page 1 use these). */
  findings: ReportFinding[]
  /** Marked "not a real problem" in every match they fired in: listed apart, like Match review's known issues. */
  filed: ReportFinding[]
  /** Page 1's rows: `findings`, with the once-only ones folded into `onceFold` when all of them would not fit on page 1 (PAGE1_ROWS). */
  rows: ReportFinding[]
  onceFold: { count: number; rules: number; text: string } | null
  notes: string[]
  trends: Trends
  grid: GridModel
  jsonFile: string
  schema: string
  version: string
}

export function dateRange(session: Session): string {
  const times = session.matches.map((m) => m.playedAt).filter((t): t is number => t !== null)
  if (times.length === 0) return ''
  const a = dateText(Math.min(...times)), b = dateText(Math.max(...times))
  return a === b ? a : `${a} to ${b}`
}

/** The safe file name base for a session's files: lowercase letters, digits, "-" and "_". */
export function sessionBase(label: string): string {
  return label.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'session'
}

/** Matches played after the issue was marked fixed, where the finding fired again (the view's "Came back after a fix"). */
export function cameBack(session: Session, issues: Map<string, IssueEvent>, key: string, matchIdx: number[]): string[] {
  const issue = issues.get(key)
  if (!issue || issue.status !== 'fixed') return []
  const fixedAt = Date.parse(issue.when)
  return matchIdx.map((i) => session.matches[i]).filter((m) => m.playedAt !== null && m.playedAt > fixedAt).map(matchLabel)
}

/** The matches where a finding was marked not a real problem, short ("Q4"). */
export function wrongIn(session: Session, f: Pick<MergedFinding, 'wrong'>): string[] {
  // A log with no match label by its file, as the mark itself names it (track-record.ts matchRef, shortMatch).
  return (f.wrong ?? []).map((w) => { const m = session.matches[w.match]; return m.matchLabel ? shortMatchLabel(m.matchLabel, w.match) : m.fileName })
}

/** Marked "not a real problem" in every match it fired in. */
export const allMarked = (f: Pick<MergedFinding, 'wrong' | 'matches'>) => (f.wrong?.length ?? 0) === f.matches.length

const SEV_RANK = { error: 0, warning: 1, info: 2 } as const

/** A rule's cells across the session, as the team's marks show them (pass the session through sessionWithMarks). */
export function gridCells(session: Session, rule: string): GridCell[] {
  return session.matches.map((m) => {
    const r = m.rules[rule]
    const status = r?.status ?? 'not checked'
    if (status !== 'fired') return { status, severity: null, marked: false }
    const all = r!.findings
    const marked = all.length > 0 && all.every((f) => f.severity === 'info' || f.wrongMark)
    const fs = marked ? all : all.filter((f) => !f.wrongMark)
    // Fired with no finding listed: shown as the worst, never quietly grey.
    const severity = fs.length ? fs.reduce((a, b) => (SEV_RANK[b.severity] < SEV_RANK[a] ? b.severity : a), fs[0].severity) : 'error'
    return { status, severity, marked }
  })
}

/**
 * The team's marks on a merged finding, in Match review's words: "marked not a real problem in Q4: <reason>", and
 * "amber, not red: marked not a real problem in Q4: <reason>" for reds a mark on another match demoted (said once
 * when it is the same mark). Empty when nothing is marked.
 */
export function marksText(session: Session, f: Pick<MergedFinding, 'wrong' | 'demoted'>): string {
  const labels = wrongIn(session, f)
  const wrong = (f.wrong ?? []).map((w, i) => `${labels[i]}${w.reason ? `: ${w.reason}` : ''}`).join('; ')
  const d = f.demoted
  const sameMark = d && f.wrong?.some((w) => w.when === d.when && w.reason === d.reason)
  return [
    wrong ? `marked not a real problem in ${wrong}` : '',
    d && sameMark ? 'its reds on the other matches show amber' : '',
    d && !sameMark ? `amber, not red: marked not a real problem in ${d.match}${d.reason ? `: ${d.reason}` : ''}` : '',
  ].filter(Boolean).join('; ')
}

export function measuredText(f: Pick<MergedFinding, 'measured'>): string {
  return f.measured
    .map((m) => `${m.label} ${fmt(m.min)}${m.max !== m.min ? `–${fmt(m.max)}` : ''}${m.unit ? ` ${m.unit}` : ''}${m.threshold !== undefined ? ` (line ${m.threshold}${m.unit ? ` ${m.unit}` : ''}${m.medianMargin !== undefined ? `, ${past(m.medianMargin)}` : ''})` : ''}`)
    .join('; ')
}

/** "2 rules crashed in 1 match: …" when a rule crashed (a bug in Hindsight): its silence says nothing about the robot. */
export function crashedNote(session: Session): string | null {
  const hit = session.matches.map((m) => Object.entries(m.rules).filter(([, r]) => r.reason?.startsWith('crashed:')).map(([id]) => id))
  const inMatches = hit.filter((h) => h.length).length
  if (!inMatches) return null
  const rules = [...new Set(hit.flat())]
  return `${plural(rules.length, 'rule', 'rules')} crashed in ${plural(inMatches, 'match', 'matches')} (a bug in Hindsight, not the robot): ${rules.join(', ')}. They count as not checked there, so their silence means nothing.`
}

/** The notes the Session view shows under the header: profile notes, misfits, split matches, clock notes, crashed rules. */
export function sessionNotes(session: Session): string[] {
  const out: string[] = []
  out.push(...new Set(session.matches.map((m) => m.robot.note).filter((n): n is string => !!n)))
  const misfits = session.matches.filter((m) => m.robot.present < PROFILE_FIT_MIN * m.robot.total)
  if (misfits.length) {
    out.push(`${misfits.length} of ${session.matches.length} matches don't fit their robot profile: as few as ${Math.min(...misfits.map((m) => m.robot.present))} of its ${misfits[0].robot.total} signals are in them. The rules about specific motors, devices, cameras and mechanisms were not run on them.`)
  }
  for (const m of session.matches.filter((x) => x.pieces)) out.push(`${m.matchLabel} is in ${m.pieces!.length} logs: the robot program restarted during the match. They count as one match here.`)
  for (const m of session.matches.filter((x) => x.clockNote)) out.push(`${matchLabel(m)}: ${m.clockNote}`)
  const crashed = crashedNote(session)
  if (crashed) out.push(crashed)
  return out
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const letter = (i: number) => (i < LETTERS.length ? LETTERS[i] : String(i + 1))

export function trendsModel(matches: MatchSummary[], typedBatteries: Record<string, string> = {}, width = 100, height = 16, pad = 3): Trends {
  const battery = (m: MatchSummary) => m.batteryId ?? typedBatteries[m.fileName] ?? ''
  const ids = [...new Set(matches.map(battery).filter(Boolean))]
  // The rows, verdicts and order are the Session view's (trendRows): the printed numbers cannot disagree with the screen.
  const panels = trendRows(matches).map((row): TrendPanel => {
    const metric = row.metric
    const base = { key: metric.key, label: metric.label, unit: metric.unit, verdict: row.verdict }
    const w = row.worstIndex
    const nums = row.values.filter((v): v is number => v !== null)
    if (nums.length === 0) return { ...base, lineY: null, points: [], range: 'not in these logs' }
    let lo = Math.min(...nums, row.line ?? Infinity), hi = Math.max(...nums, row.line ?? -Infinity)
    if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
    const x = (i: number) => pad + (matches.length === 1 ? (width - 2 * pad) / 2 : (i * (width - 2 * pad)) / (matches.length - 1))
    const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad)
    const points: TrendPoint[] = []
    row.values.forEach((v, i) => { if (v !== null) points.push({ id: matches[i].fileName, match: matchLabel(matches[i]), value: v, x: x(i), y: y(v), letter: battery(matches[i]) ? letter(ids.indexOf(battery(matches[i]))) : '', worst: i === w }) })
    return {
      ...base, lineY: row.line !== null ? y(row.line) : null, points,
      range: `${Math.min(...nums).toFixed(metric.digits)}–${Math.max(...nums).toFixed(metric.digits)}`,
    }
  })
  return { width, height, pad, panels, batteries: ids.map((id, i) => ({ letter: letter(i), id })), order: matches.map(matchLabel), anyUnlabelled: matches.some((m) => !battery(m)) }
}

export function gridModel(session: Session): GridModel {
  const rows = ruleGrid(session).map((r: RuleRow) => ({
    rule: r.rule, title: r.title, cells: r.cells, firedAnywhere: r.fired > 0, marked: gridCells(session, r.rule).map((c) => c.marked),
    rate: r.checkable ? `${CONFIDENCE_WORDS[r.confidence]}: ${r.fired} of ${r.checkable}` : 'not checked',
  }))
  // Rules that fired anywhere first (most matches first), then the rest in the rules' own order.
  const fired = rows.filter((r) => r.firedAnywhere).sort((a, b) => b.cells.filter((c) => c === 'fired').length - a.cells.filter((c) => c === 'fired').length)
  return { columns: session.matches.map((m) => ({ id: m.fileName, label: matchLabel(m) })), rows: [...fired, ...rows.filter((r) => !r.firedAnywhere)] }
}

/**
 * Page 1 holds this many finding rows with the trends below them (22 rows fit with room to spare on the 3-match
 * long session). Past it, the once-only findings fold into one line.
 */
export const PAGE1_ROWS = 24

/**
 * When the list is too long for page 1, it keeps a full row for every finding that repeated; the ones seen in a single match fold into one line grouped by
 * rule, errors first: "Once (47 in 6 rules): can/device-dropout ×30 (Qualification 2); …". The full rows stay in the JSON.
 */
export function fold(findings: ReportFinding[]): { rows: ReportFinding[]; onceFold: SessionModel['onceFold'] } {
  // A finding that stopped firing stays a row: it is the news.
  const folds = (f: ReportFinding) => f.confidence === 'once' && !f.sinks
  const once = findings.filter(folds)
  if (findings.length <= PAGE1_ROWS || once.length === 0) return { rows: findings, onceFold: null }
  const groups = new Map<string, { n: number; errors: number; labels: Set<string> }>()
  for (const f of once) {
    const g = groups.get(f.rule) ?? { n: 0, errors: 0, labels: new Set<string>() }
    g.n++
    if (f.severity === 'error') g.errors++
    f.matchLabels.forEach((l) => g.labels.add(l))
    groups.set(f.rule, g)
  }
  const sorted = [...groups].sort((a, b) => (b[1].errors > 0 ? 1 : 0) - (a[1].errors > 0 ? 1 : 0) || b[1].n - a[1].n)
  const part = ([rule, g]: (typeof sorted)[number]) => {
    const l = [...g.labels]
    return `${rule} ×${g.n} (${l.slice(0, 3).join(', ')}${l.length > 3 ? ` +${l.length - 3}` : ''})`
  }
  const shown = sorted.slice(0, 10).map(part).join('; ')
  const more = sorted.length > 10 ? `; +${sorted.length - 10} more rules` : ''
  return { rows: findings.filter((f) => !folds(f)), onceFold: { count: once.length, rules: groups.size, text: `${shown}${more}` } }
}

const ORDER: Confidence[] = ['consistent', 'intermittent', 'once', 'not enough data']

/**
 * "3 matches. Consistent: flywheel followers slow, 3 of 3. Once: brownout, 1 of 3. Stopped: hood zeroed late, not seen
 * since Q4, 1 in 35." One clause per confidence, worst first, then the potentially fixed warnings.
 */
export function bottomLine(matchCount: number, findings: ReportFinding[], filed = 0): string {
  const head = `${plural(matchCount, 'match')}.`
  const marked = filed ? ` ${filed} marked not a real problem in every match ${filed === 1 ? 'it' : 'they'} fired in.` : ''
  if (findings.length === 0) return `${head} No ${filed ? 'other ' : ''}errors or warnings in any match.${marked}`
  // The first two by rule name (several findings can share a rule), then how many more.
  const clause = (word: string, here: ReportFinding[], what: (f: ReportFinding) => string) => {
    if (!here.length) return []
    const named = [...new Map(here.map((f) => [f.ruleTitle, f])).values()].slice(0, 2)
    const more = here.length - named.length
    return [`${word}: ${named.map((f) => `${f.ruleTitle}, ${what(f)}`).join('; ')}${more ? ` (+${more} more)` : ''}.`]
  }
  const live = findings.filter((f) => !f.sinks)
  const clauses = [
    ...ORDER.flatMap((c) => clause(CONFIDENCE_WORDS[c], live.filter((f) => f.confidence === c), (f) => f.ratio)),
    ...clause('Stopped', findings.filter((f) => f.sinks), (f) => f.stoppedShort),
  ]
  return `${head} ${clauses.join(' ')}${marked}`
}

/** Pass the session as the team's marks show it (triage/track-record.ts sessionWithMarks). */
export function sessionModel(session: Session, issues: Map<string, IssueEvent> = new Map(), typedBatteries: Record<string, string> = {}): SessionModel {
  // The report's order (not the view's): how sure we are first, then how serious, then in how many matches.
  const rank = (c: Confidence) => ORDER.indexOf(c)
  const sev = { error: 0, warning: 1 }
  const merged = mergeFindings(session).filter((f): f is MergedFinding & { severity: 'error' | 'warning' } => f.severity !== 'info')
  const stopped = new Map(merged.map((f) => [f.key, stoppedFiring(session, f, issues.get(f.key))]))
  const sunk = (f: MergedFinding) => sinks(stopped.get(f.key) ?? null, f.severity)
  // Potentially fixed warnings go below the live findings.
  const ordered = merged.sort((a, b) => Number(sunk(a)) - Number(sunk(b)) || rank(a.confidence) - rank(b.confidence) || sev[a.severity] - sev[b.severity] || b.matches.length - a.matches.length)
  const all = ordered.map((f): ReportFinding => {
    const ratio = `${f.matches.length} of ${f.checkable}`
    const s = stopped.get(f.key) ?? null
    return {
      key: f.key, rule: f.rule, severity: f.severity, sevWord: f.severity === 'error' ? 'Error' : 'Warning',
      confidence: f.confidence, confidenceWord: CONFIDENCE_WORDS[f.confidence], ruleTitle: ruleById(f.rule)?.title ?? f.rule, title: cardTitle(f.title),
      ratio,
      rateText: `fired in ${ratio} where it could be checked (${interval(f.interval)})`,
      measured: measuredText(f), cameBack: cameBack(session, issues, f.key, f.matches),
      stopped: s ? stoppedText(session, s, f) : '', sinks: sunk(f), stoppedShort: s?.kind === 'not seen' && sunk(f) ? stoppedShort(session, s) : '',
      cardStopped: stoppedCard(session, s), potentiallyFixed: s?.kind === 'not seen' && s.potentiallyFixed,
      matchLabels: f.matches.map((i) => matchLabel(session.matches[i])),
      cardMeasured: f.measured[0] && !(f.measured[0].min === f.measured[0].max && titleHasValue(cardTitle(f.title), f.measured[0].min)) ? measuredText({ measured: [f.measured[0]] }) : '',
      marks: marksText(session, f), wrongIn: wrongIn(session, f),
    }
  })
  const isFiled = new Set(ordered.filter(allMarked).map((f) => f.key))
  const findings = all.filter((f) => !isFiled.has(f.key))
  const filed = all.filter((f) => isFiled.has(f.key))
  const byRobot = new Map<string, { m: MatchSummary; n: number }>()
  for (const m of session.matches) { const { key } = summaryRobot(m.robot); byRobot.set(key, { m, n: (byRobot.get(key)?.n ?? 0) + 1 }) }
  const model: SessionModel = {
    label: session.label, kind: KIND_WORDS[session.kind], dates: dateRange(session), matchCount: session.matches.length,
    robots: [...byRobot.values()].map(({ m, n }) => { const r = summaryRobot(m.robot); return { name: r.name, code: r.named ? pinText(m.robot.code) : '', matches: n } }),
    builds: buildsOf(session.matches),
    uncommitted: session.matches.filter((m) => m.build?.uncommitted).length,
    buildUnknown: session.matches.filter((m) => !m.build || (!m.build.sha && !m.build.branch)).length,
    bottomLine: bottomLine(session.matches.length, findings, filed.length),
    findings, filed, ...fold(findings), notes: sessionNotes(session), trends: trendsModel(session.matches, typedBatteries), grid: gridModel(session),
    jsonFile: `${sessionBase(session.label)}.session-findings.json`, schema: SESSION_FINDINGS_SCHEMA, version: VERSION,
  }
  return model
}

/** "1a2b3c4 on main", or "" when the profile names no commit ("unknown" is what a profile with no pinned code says). */
function pinText(code: { sha?: string; branch?: string }): string {
  const sha = code.sha && code.sha !== 'unknown' ? code.sha.slice(0, 7) : ''
  const branch = code.branch && code.branch !== 'unknown' ? code.branch : ''
  return sha || branch ? `${sha || '?'} on ${branch || '?'}` : ''
}

function buildsOf(matches: MatchSummary[]): SessionModel['builds'] {
  const by = new Map<string, SessionModel['builds'][number]>()
  for (const m of matches) {
    if (!m.build || (!m.build.sha && !m.build.branch)) continue
    const key = `${m.build.sha}|${m.build.branch}|${m.build.uncommitted}`
    const e = by.get(key) ?? { sha: m.build.sha, branch: m.build.branch, uncommitted: m.build.uncommitted, matches: 0 }
    e.matches++
    by.set(key, e)
  }
  return [...by.values()].sort((a, b) => b.matches - a.matches)
}

/** What the logs ran, in words: "code d339f29 (2 matches), 123eec6". Empty when no log recorded it. */
export function ranText(m: SessionModel): string {
  if (!m.builds.length) return ''
  const shas = new Map<string, number>()
  for (const b of m.builds) shas.set(b.sha || '?', (shas.get(b.sha || '?') ?? 0) + b.matches)
  return `logs ran code ${[...shas].map(([sha, n]) => (n > 1 ? `${sha} (${n} matches)` : sha)).join(', ')}`
}

/** The header's build lines: the robot profile(s), what the logs ran, and a count of matches that ran uncommitted code. */
export function buildText(m: SessionModel): string {
  const robots = m.robots.map((r) => `${r.name}${r.code ? ` (profile from code ${r.code})` : ''}${m.robots.length > 1 ? `, ${plural(r.matches, 'match')}` : ''}`).join('; ')
  const ran = ranText(m)
  const dirty = [...new Set(m.builds.filter((b) => b.uncommitted).map((b) => b.sha || '?'))].join(', ')
  const flag = m.uncommitted ? `${m.uncommitted} of ${m.matchCount} ${m.matchCount === 1 ? 'match' : 'matches'} ran UNCOMMITTED changes${dirty ? ` (${dirty})` : ''}` : ''
  const unknown = m.buildUnknown ? `build not recorded in ${m.buildUnknown} of ${m.matchCount}` : ''
  return [robots, ran, flag, unknown].filter(Boolean).join(' · ')
}

/** The phone card for a session: the match count, the counts by confidence, then merged errors and warnings. */
export function sessionCard(m: SessionModel): CardModel {
  const count = (c: Confidence) => m.findings.filter((f) => f.confidence === c && !f.sinks).length
  const stoppedCount = m.findings.filter((f) => f.sinks).length
  const parts = [...ORDER.filter(count).map((c) => `${count(c)} ${c}`), ...(stoppedCount ? [`${stoppedCount} stopped`] : [])]
  return {
    context: [m.label, m.dates].filter(Boolean).join(' · '),
    heading: plural(m.matchCount, 'match'),
    headingTone: 'muted' as Tone,
    subheading: [parts.length ? parts.join(' · ') : m.filed.length ? 'No other errors or warnings' : 'No errors or warnings in any match', m.filed.length ? `${m.filed.length} not a real problem` : ''].filter(Boolean).join(' · '),
    items: m.findings.map((f) => ({
      word: `${f.sevWord.toUpperCase()}${f.confidence === 'quiet' ? '' : ` · ${f.confidenceWord.toUpperCase()}`}${f.cameBack.length ? ' · CAME BACK' : ''}${f.potentiallyFixed ? ' · POTENTIALLY FIXED' : ''}`,
      tone: (f.severity === 'error' ? 'error' : 'warning') as Tone,
      title: f.title,
      number: [`${f.ratio} ${f.ratio.endsWith(' of 1') ? 'match' : 'matches'}`, f.cardMeasured, f.wrongIn.length ? `not a real problem in ${f.wrongIn.join(', ')}` : '', f.cardStopped].filter(Boolean).join(' · '),
      short: `${f.ruleTitle} (${f.matchLabels.join(', ')})`,
    })),
    emptyText: 'Nothing to fix from these logs.',
    footer: [m.robots.map((r) => r.name).join('; '), ranText(m).replace(/^logs ran code/, 'Code ran').replace(/ \(\d+ matches\)/g, ''), `Hindsight ${m.version}`].filter(Boolean),
    uncommitted: m.uncommitted > 0,
    uncommittedText: `UNCOMMITTED CODE ran ${m.uncommitted} of ${m.matchCount} ${m.matchCount === 1 ? 'match' : 'matches'}`,
  }
}
