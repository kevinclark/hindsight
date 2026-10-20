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
import type { MatchMetrics, MatchSummary, RuleStatus } from '../session/summary.ts'
import type { CardModel, Tone } from './card.ts'
import { ruleById } from '../rules/index.ts'
import { cardTitle } from './titles.ts'

/** The numbers the Trends small multiples draw, with the rule's line where there is one. Shared with Trends.svelte. */
export const TREND_METRICS: { key: keyof MatchMetrics; label: string; unit: string; digits: number; line?: number }[] = [
  { key: 'minVolts', label: 'Lowest voltage', unit: 'V', digits: 2, line: 7 },
  { key: 'secondsUnder7', label: 'Time under 7 V', unit: 's', digits: 1 },
  { key: 'chargeAh', label: 'Charge drawn', unit: 'Ah', digits: 2 },
  { key: 'resistanceMilliohms', label: 'Battery + wiring', unit: 'mΩ', digits: 1, line: 20 },
  { key: 'followerSpeedPct', label: 'Slowest follower vs leader', unit: '%', digits: 0, line: 85 },
  { key: 'loopOverrunPct', label: 'Auto loops over 20 ms', unit: '%', digits: 1, line: 10 },
  { key: 'visionOutlierPct', label: 'Vision poses > 0.5 m off', unit: '%', digits: 1, line: 5 },
]

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
}

export interface TrendPoint { match: string; value: number; x: number; y: number; letter: string }
export interface TrendPanel {
  key: string; label: string; unit: string
  /** y of the rule's line, when it has one. */
  lineY: number | null
  points: TrendPoint[]
  /** "7.1–10.6", the scale shared by every match. */
  range: string
}
export interface Trends {
  width: number; height: number
  panels: TrendPanel[]
  /** One letter per battery, so identity never rests on colour. */
  batteries: { letter: string; id: string }[]
  /** Matches left to right, as labelled. */
  order: string[]
  /** A match with no battery ID gets no letter. */
  anyUnlabelled: boolean
}

export interface GridModel {
  columns: string[]
  rows: { rule: string; title: string; cells: RuleStatus[]; rate: string; firedAnywhere: boolean }[]
}

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
  findings: ReportFinding[]
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

export function measuredText(f: Pick<MergedFinding, 'measured'>): string {
  return f.measured
    .map((m) => `${m.label} ${fmt(m.min)}${m.max !== m.min ? `–${fmt(m.max)}` : ''}${m.unit ? ` ${m.unit}` : ''}${m.threshold !== undefined ? ` (line ${m.threshold}${m.unit ? ` ${m.unit}` : ''}${m.medianMargin !== undefined ? `, ${past(m.medianMargin)}` : ''})` : ''}`)
    .join('; ')
}

/** The notes the Session view shows under the header: profile notes, misfits, split matches, clock notes. */
export function sessionNotes(session: Session): string[] {
  const out: string[] = []
  out.push(...new Set(session.matches.map((m) => m.robot.note).filter((n): n is string => !!n)))
  const misfits = session.matches.filter((m) => m.robot.present < PROFILE_FIT_MIN * m.robot.total)
  if (misfits.length) {
    out.push(`${misfits.length} of ${session.matches.length} matches don't fit their robot profile: as few as ${Math.min(...misfits.map((m) => m.robot.present))} of its ${misfits[0].robot.total} signals are in them. The rules about specific motors, devices, cameras and mechanisms were not run on them.`)
  }
  for (const m of session.matches.filter((x) => x.pieces)) out.push(`${m.matchLabel} is in ${m.pieces!.length} logs: the robot program restarted during the match. They count as one match here.`)
  for (const m of session.matches.filter((x) => x.clockNote)) out.push(`${matchLabel(m)}: ${m.clockNote}`)
  return out
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const letter = (i: number) => (i < LETTERS.length ? LETTERS[i] : String(i + 1))

export function trendsModel(matches: MatchSummary[], typedBatteries: Record<string, string> = {}, width = 100, height = 34, pad = 5): Trends {
  const battery = (m: MatchSummary) => m.batteryId ?? typedBatteries[m.fileName] ?? ''
  const ids = [...new Set(matches.map(battery).filter(Boolean))]
  const panels = TREND_METRICS.map((metric): TrendPanel => {
    const vals = matches.map((m) => m.metrics[metric.key])
    const nums = vals.filter((v): v is number => v !== null && Number.isFinite(v))
    if (nums.length === 0) return { key: metric.key, label: metric.label, unit: metric.unit, lineY: null, points: [], range: 'not in these logs' }
    let lo = Math.min(...nums, metric.line ?? Infinity), hi = Math.max(...nums, metric.line ?? -Infinity)
    if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
    const x = (i: number) => pad + (matches.length === 1 ? (width - 2 * pad) / 2 : (i * (width - 2 * pad)) / (matches.length - 1))
    const y = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad)
    const points: TrendPoint[] = []
    vals.forEach((v, i) => { if (v !== null && Number.isFinite(v)) points.push({ match: matchLabel(matches[i]), value: v, x: x(i), y: y(v), letter: battery(matches[i]) ? letter(ids.indexOf(battery(matches[i]))) : '' }) })
    return {
      key: metric.key, label: metric.label, unit: metric.unit, lineY: metric.line !== undefined ? y(metric.line) : null, points,
      range: `${Math.min(...nums).toFixed(metric.digits)}–${Math.max(...nums).toFixed(metric.digits)}`,
    }
  })
  return { width, height, panels, batteries: ids.map((id, i) => ({ letter: letter(i), id })), order: matches.map(matchLabel), anyUnlabelled: matches.some((m) => !battery(m)) }
}

export function gridModel(session: Session): GridModel {
  const rows = ruleGrid(session).map((r: RuleRow) => ({
    rule: r.rule, title: r.title, cells: r.cells, firedAnywhere: r.fired > 0,
    rate: r.checkable ? `${CONFIDENCE_WORDS[r.confidence]}: ${r.fired} of ${r.checkable}` : 'not checked',
  }))
  // Rules that fired anywhere first (most matches first), then the rest in the rules' own order.
  const fired = rows.filter((r) => r.firedAnywhere).sort((a, b) => b.cells.filter((c) => c === 'fired').length - a.cells.filter((c) => c === 'fired').length)
  return { columns: session.matches.map(matchLabel), rows: [...fired, ...rows.filter((r) => !r.firedAnywhere)] }
}

const ORDER: Confidence[] = ['consistent', 'intermittent', 'once', 'not enough data']

/** "3 matches. Consistent: flywheel followers slow, 3 of 3. Once: brownout, 1 of 3." One clause per confidence, worst first. */
export function bottomLine(matchCount: number, findings: ReportFinding[]): string {
  const head = `${plural(matchCount, 'match')}.`
  if (findings.length === 0) return `${head} No errors or warnings in any match.`
  const clauses = ORDER.flatMap((c) => {
    const here = findings.filter((f) => f.confidence === c)
    if (!here.length) return []
    // The first two by rule name (several findings can share a rule), then how many more.
    const named = [...new Map(here.map((f) => [f.ruleTitle, f])).values()].slice(0, 2)
    const more = here.length - named.length
    return [`${CONFIDENCE_WORDS[c]}: ${named.map((f) => `${f.ruleTitle}, ${f.ratio}`).join('; ')}${more ? ` (+${more} more)` : ''}.`]
  })
  return `${head} ${clauses.join(' ')}`
}

export function sessionModel(session: Session, issues: Map<string, IssueEvent> = new Map(), typedBatteries: Record<string, string> = {}): SessionModel {
  const findings = mergeFindings(session).filter((f): f is MergedFinding & { severity: 'error' | 'warning' } => f.severity !== 'info').map((f): ReportFinding => {
    const ratio = `${f.matches.length} of ${f.checkable}`
    return {
      key: f.key, rule: f.rule, severity: f.severity, sevWord: f.severity === 'error' ? 'Error' : 'Warning',
      confidence: f.confidence, confidenceWord: CONFIDENCE_WORDS[f.confidence], ruleTitle: ruleById(f.rule)?.title ?? f.rule, title: cardTitle(f.title),
      ratio,
      rateText: `fired in ${ratio} where it could be checked (${interval(f.interval)})`,
      measured: measuredText(f), cameBack: cameBack(session, issues, f.key, f.matches),
    }
  })
  const byRobot = new Map<string, { m: MatchSummary; n: number }>()
  for (const m of session.matches) byRobot.set(m.robot.profileId, { m, n: (byRobot.get(m.robot.profileId)?.n ?? 0) + 1 })
  const model: SessionModel = {
    label: session.label, kind: KIND_WORDS[session.kind], dates: dateRange(session), matchCount: session.matches.length,
    robots: [...byRobot.values()].map(({ m, n }) => ({ name: m.robot.name, code: pinText(m.robot.code), matches: n })),
    builds: buildsOf(session.matches),
    uncommitted: session.matches.filter((m) => m.build?.uncommitted).length,
    buildUnknown: session.matches.filter((m) => !m.build || (!m.build.sha && !m.build.branch)).length,
    bottomLine: bottomLine(session.matches.length, findings),
    findings, notes: sessionNotes(session), trends: trendsModel(session.matches, typedBatteries), grid: gridModel(session),
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
  const count = (c: Confidence) => m.findings.filter((f) => f.confidence === c).length
  const parts = ORDER.filter(count).map((c) => `${count(c)} ${c}`)
  return {
    context: [m.label, m.dates].filter(Boolean).join(' · '),
    heading: plural(m.matchCount, 'match'),
    headingTone: 'muted' as Tone,
    subheading: parts.length ? parts.join(' · ') : 'No errors or warnings in any match',
    items: m.findings.map((f) => ({
      word: `${f.sevWord.toUpperCase()}${f.confidence === 'quiet' ? '' : ` · ${f.confidenceWord.toUpperCase()}`}${f.cameBack.length ? ' · CAME BACK' : ''}`,
      tone: (f.severity === 'error' ? 'error' : 'warning') as Tone,
      title: f.title,
      number: [`${f.ratio} ${f.ratio.endsWith(' of 1') ? 'match' : 'matches'}`, f.measured.split('; ')[0]].filter(Boolean).join(' · '),
    })),
    emptyText: 'Nothing to fix from these logs.',
    footer: [m.robots.map((r) => r.name).join('; '), ranText(m).replace(/^logs ran code/, 'Code ran').replace(/ \(\d+ matches\)/g, ''), `Hindsight ${m.version}`].filter(Boolean),
    uncommitted: m.uncommitted > 0,
    uncommittedText: `UNCOMMITTED CODE ran ${m.uncommitted} of ${m.matchCount} ${m.matchCount === 1 ? 'match' : 'matches'}`,
  }
}
