/**
 * What the Match review report and its phone card say, computed once from what the Match tab already knows
 * (the same active / known split as MatchTab, the same findings as findings.json). No layout here.
 */

import type { Analysis } from '../analyze.ts'
import { ruleById } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import type { IssueEvent } from '../triage/history.ts'
import { VERSION } from '../version.ts'
import { SCHEMA, findingsFileName } from './findings-json.ts'
import type { CardModel, Tone } from './card.ts'
import { descendants, nest, type FindingNode } from './finding-tree.ts'

export type FindingStatus = 'known' | 'came back' | 'fixed later'

/** When this match was played (wall clock, ms), so a fix recorded after it doesn't make it "came back". */
export function playedAt(analysis: Analysis): number | null {
  const m = analysis.match
  return m.epochOffset !== null && m.matchStart !== null ? (m.epochOffset + m.matchStart) * 1000 : null
}

export function findingStatus(f: Finding, issues: Map<string, IssueEvent>, played: number | null): FindingStatus | undefined {
  const issue = issues.get(f.key)
  if (!issue) return undefined
  if (issue.status === 'known') return 'known'
  const fixedAt = Date.parse(issue.when)
  // If we can't tell when the match was played or when the fix was, don't call it "came back": file it as known.
  if (played === null || Number.isNaN(fixedAt)) return 'fixed later'
  return played < fixedAt ? 'fixed later' : 'came back'
}

export interface ReviewModel {
  /** New findings (and ones that came back), worst first: the app's "Everyone" list. */
  active: Finding[]
  known: Finding[]
  /** The active findings as headlines, with the findings each explains under it (finding-tree.ts). */
  headlines: FindingNode[]
  knownHeadlines: FindingNode[]
  errors: Finding[]
  warnings: Finding[]
  infos: Finding[]
  notChecked: { rule: string; reason: string }[]
  /** Rules that crashed (a Hindsight bug): they say nothing about the log either. */
  crashed: { rule: string; reason: string }[]
  /** Keys of active findings that came back after being marked fixed. */
  cameBack: Set<string>
  header: ReviewHeader
  bottomLine: string
  /** Names the matching findings.json. */
  jsonFile: string
  schema: string
}

export interface ReviewHeader {
  robot: string
  event: string
  matchLabel: string
  date: string
  logFile: string
  dsFiles: string[]
  build: BuildLine
  version: string
}

export interface BuildLine { sha: string; branch: string; uncommitted: boolean; text: string }

export function buildLine(b: { sha: string; branch: string; dirty: string }): BuildLine {
  const sha = b.sha.slice(0, 7)
  const uncommitted = /uncommitted/i.test(b.dirty)
  const text = !sha && !b.branch ? 'code build not recorded in this log' : `code ${sha || '?'} on ${b.branch || '?'}${uncommitted ? ' (UNCOMMITTED changes)' : ''}`
  return { sha, branch: b.branch, uncommitted, text }
}

/** "2026-10-18", from the robot's clock when it was set; empty when it never was. */
export function matchDate(analysis: Analysis): string {
  const t = playedAt(analysis)
  if (t === null) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function reviewModel(analysis: Analysis, issues: Map<string, IssueEvent>): ReviewModel {
  // Always the "Everyone" list: a report must not depend on which audience the viewer last picked.
  const all = analysis.report.findings.filter((f) => f.rule !== 'meta/not-checked')
  const played = playedAt(analysis)
  const active = all.filter((f) => { const s = findingStatus(f, issues, played); return !s || s === 'came back' })
  const known = all.filter((f) => { const s = findingStatus(f, issues, played); return s === 'known' || s === 'fixed later' })
  const bySeverity = (s: string) => active.filter((f) => f.severity === s)
  const m = analysis.match
  const model = {
    active, known,
    headlines: nest(active, all, known), knownHeadlines: nest(known, all),
    errors: bySeverity('error'), warnings: bySeverity('warning'), infos: bySeverity('info'),
    notChecked: analysis.report.skipped.map((s) => ({ rule: s.rule, reason: s.reason })),
    crashed: analysis.report.crashed.map((s) => ({ rule: s.rule, reason: `crashed: ${s.reason}` })),
    cameBack: new Set(active.filter((f) => findingStatus(f, issues, played) === 'came back').map((f) => f.key)),
    header: {
      robot: m.profile.name, event: m.event, matchLabel: m.matchLabel, date: matchDate(analysis), logFile: m.fileName,
      dsFiles: m.ds.map((d) => d.fileName), build: buildLine(m.build), version: VERSION,
    },
    bottomLine: '',
    jsonFile: findingsFileName(m), schema: SCHEMA,
  }
  // "Worst:" names a headline, not a finding shown under one (the counts still count every finding).
  const heads = new Set(model.headlines.map((n) => n.finding))
  const headlinesFirst = (list: Finding[]) => [...list.filter((f) => heads.has(f)), ...list.filter((f) => !heads.has(f))]
  model.bottomLine = bottomLine(headlinesFirst(model.errors), headlinesFirst(model.warnings), model.infos, known.length)
  return model
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The card's title without its asides, then cut at a stop (", first at ", "(median …") and at 70 characters on a word boundary. */
export function shortTitle(title: string): string {
  const cut = cardTitle(title).split(/, first at |\s*\((?:median|worst) /)[0].trim()
  if (cut.length <= 70) return cut
  const words = cut.slice(0, 69).split(' ')
  if (words.length > 1 && cut[69] !== ' ') words.pop()
  return `${words.join(' ').replace(/[\s,;:]+$/, '')}…`
}

export function bottomLine(errors: Finding[], warnings: Finding[], infos: Finding[], known: number): string {
  const tail = `${plural(warnings.length, 'warning')}, ${infos.length} info${known ? `, ${known} known` : ''}`
  const stop = (t: string) => (t.endsWith('…') ? t : `${t}.`)
  if (errors.length === 0) return warnings.length ? `No errors. ${tail}. Worst: ${stop(shortTitle(warnings[0].title))}` : `No errors or warnings. ${tail}.`
  const rest = errors.length - 1
  const more = rest ? `; +${rest} more error${rest === 1 ? '' : 's'}.` : ''
  return `${plural(errors.length, 'error')}, ${tail}. Worst: ${rest ? shortTitle(errors[0].title) : stop(shortTitle(errors[0].title))}${more}`
}

/** True when the title already says this number (not as part of a time like 2:27 or a longer number). */
export function titleHasValue(title: string, value: number | string): boolean {
  const v = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\d.:])${v}(?![\\d:]|\\.\\d)`).test(title)
}

/**
 * The one decisive number for a finding: the judged measurement when the rule gave one, else the first evidence line.
 * `inTitle`: the title already says it (the card and the report then leave the number line out).
 * The threshold is the rule's trip line, not a limit ("line", as the Session view says).
 */
export function keyNumber(f: Finding): { label: string; value: string; text: string; inTitle: boolean } {
  const m = f.measured?.[0]
  if (m) {
    const unit = m.unit ? ` ${m.unit}` : ''
    const value = `${m.value}${unit}${m.threshold !== undefined ? ` (line ${m.threshold}${unit})` : ''}`
    return { label: m.label, value, text: `${value} ${m.label}`, inTitle: titleHasValue(f.title, m.value) }
  }
  // Fallback: the first evidence line that holds a number ("group: Alerts" says nothing on a card).
  const first = Object.entries(f.evidence).find(([, v]) => /\d/.test(String(v)))
  if (!first) return { label: '', value: '', text: '', inTitle: false }
  const value = String(first[1])
  return { label: first[0], value, text: `${first[0]}: ${value}`, inTitle: titleHasValue(f.title, value) }
}

/** "2:25 into the match" from "2:25 into the match (teleop; robot time 532.8 s)", for tight places. */
export function shortWhen(when: string | null): string {
  return when ? when.replace(/\s*\(.*$/, '') : ''
}

/** A finding's title for the card: without the "(teleop; robot time 417.4 s)" aside, which the PDF keeps (card space is tight). */
export function cardTitle(title: string): string {
  return title.replace(/\s*\([^()]*robot time [\d.]+ s\)/g, '').replace(/\s*\(as of [^()]*\)/g, '').replace(/\s+/g, ' ').trim()
}

/** Drops the repo-path citations in a rule's `incident` text: "(…q13-log-analysis.md §1)" means nothing to a student. */
export function stripRepoPaths(text: string): string {
  return text
    .replace(/\s*\([^()]*\.md[^()]*\)/g, '')
    .replace(/\s*\((?:P0|Q13) analysis[^()]*\)/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
}

export function incidentFor(f: Finding): string {
  const r = ruleById(f.rule)
  return r ? stripRepoPaths(r.incident) : ''
}

/** The phone card for a Match review: counts first, then each error's title and one number. */
export function reviewCard(m: ReviewModel): CardModel {
  const h = m.header
  // One item per headline: a finding that another explains is counted in the heading, not listed again.
  const tone: Tone = m.errors.length ? 'error' : 'warning'
  const worst = m.headlines.filter((n) => n.finding.severity === tone)
  const n = m.errors.length
  const crashed = m.crashed.length ? ` · ${plural(m.crashed.length, 'rule')} crashed` : ''
  return {
    context: [h.matchLabel || 'Match', h.event, h.date].filter(Boolean).join(' · '),
    heading: n ? plural(n, 'error') : 'No errors',
    headingTone: n ? 'error' : 'ok',
    subheading: `${plural(m.warnings.length, 'warning')} · ${m.infos.length} info${m.known.length ? ` · ${m.known.length} known` : ''}${crashed}`,
    items: worst.map((n) => {
      const f = n.finding
      const k = keyNumber(f)
      const word = (m.errors.length ? 'ERROR' : 'WARNING') + (m.cameBack.has(f.key) ? ' · CAME BACK' : '')
      const under = descendants(n).length
      const number = [k.inTitle ? '' : k.text, under ? `explains ${under} more` : ''].filter(Boolean).join(' · ')
      return { word, tone, title: cardTitle(f.title), number }
    }),
    emptyText: 'Nothing to fix from this log.',
    footer: [h.build.text, `Hindsight ${h.version}`],
    uncommitted: h.build.uncommitted,
    uncommittedText: 'UNCOMMITTED CODE ran this match',
  }
}
