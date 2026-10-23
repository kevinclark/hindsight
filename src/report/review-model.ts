/**
 * What the Match review report and its phone card say, computed once from what the Match tab already knows
 * (the same active / known split as MatchTab, the same findings as findings.json). No layout here.
 */

import type { Analysis } from '../analyze.ts'
import { isUncommitted } from '../match/git-dirty.ts'
import { makerOf } from '../rules/index.ts'
import type { Finding, Severity } from '../rules/types.ts'
import type { IssueEvent } from '../triage/history.ts'
import { VERSION } from '../version.ts'
import { SCHEMA, findingsFileName } from './findings-json.ts'
import type { CardModel, Tone } from './card.ts'
import { descendants, nest, partitionStanding, severityWords, withParents, type FindingNode } from './finding-tree.ts'
import { cardTitle, shortTitle } from './titles.ts'
import { stripRepoPaths } from './repo-paths.ts'
import { playedAt as summaryPlayedAt } from '../session/summary.ts'

export { cardTitle, shortTitle } from './titles.ts'
export { stripRepoPaths } from './repo-paths.ts'

/** `wrong`: marked "not a real problem" on this match; it is listed with the known issues. */
export type FindingStatus = 'known' | 'came back' | 'fixed later' | 'wrong'

/**
 * When this match was played (wall clock, ms), so a fix recorded after it doesn't make it "came back" and a wrong mark
 * finds the other matches of its event. The Session view's definition (session/summary.ts), so the two views agree:
 * the robot clock, else the file name's date.
 */
export function playedAt(analysis: Analysis): number | null {
  return summaryPlayedAt(analysis.match).playedAt
}

/** `wrong`: this match's wrong marks, by issue key (track-record.ts wrongHere). */
export function findingStatus(f: Pick<Finding, 'key'>, issues: Map<string, IssueEvent>, played: number | null, wrong: Map<string, IssueEvent> = new Map()): FindingStatus | undefined {
  if (wrong.has(f.key)) return 'wrong'
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
  /**
   * Headlines folded because they fired in every match of the loaded session (finding-tree.ts partitionStanding, the
   * same split as the Match tab): left out of `headlines`, named in one line. Empty without a session. Counts
   * (`errors`, `warnings`, ...) still include them.
   */
  standing: FindingNode[]
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
  const uncommitted = isUncommitted(b.dirty)
  const text = !sha && !b.branch ? 'code build not recorded in this log' : `code ${sha || '?'} on ${b.branch || '?'}${uncommitted ? ' (UNCOMMITTED changes)' : ''}`
  return { sha, branch: b.branch, uncommitted, text }
}

/** "2026-10-18", from the robot's clock when it was set; empty when it never was. */
export function matchDate(analysis: Analysis): string {
  const m = analysis.match
  const t = m.epochOffset !== null && m.matchStart !== null ? (m.epochOffset + m.matchStart) * 1000 : null
  if (t === null) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Pass the analysis as the team's marks show it (track-record.ts withMarks) and this match's wrong marks. */
export function reviewModel(analysis: Analysis, issues: Map<string, IssueEvent>, standingKeys: Set<string> = new Set(), wrong: Map<string, IssueEvent> = new Map()): ReviewModel {
  // Always the "Everyone" list: a report must not depend on which audience the viewer last picked.
  const all = analysis.report.findings.filter((f) => f.rule !== 'meta/not-checked')
  // Parents name a group of findings (src/rules/parents.ts): listed with them, never counted.
  const parents = analysis.report.parents ?? []
  const withGroups = [...all, ...parents]
  const played = playedAt(analysis)
  const status = (f: Finding) => findingStatus(f, issues, played, wrong)
  const isActive = (f: Finding) => { const s = status(f); return !s || s === 'came back' }
  const isKnown = (f: Finding) => { const s = status(f); return s === 'known' || s === 'fixed later' || s === 'wrong' }
  const active = all.filter(isActive)
  const known = all.filter(isKnown)
  const bySeverity = (s: string) => active.filter((f) => f.severity === s)
  const m = analysis.match
  const cameBackList = active.filter((f) => status(f) === 'came back')
  // A parent heads its group wherever the group is: marked known, it still heads new members (MatchTab does the same).
  const fullHeadlines = nest(withParents(active, parents), withGroups, withGroups.filter(isKnown), cameBackList)
  const partition = partitionStanding(fullHeadlines, standingKeys, cameBackList, parents)
  const model = {
    active, known,
    headlines: partition.listed, standing: partition.folded,
    knownHeadlines: nest(withParents(known, parents), withGroups),
    errors: bySeverity('error'), warnings: bySeverity('warning'), infos: bySeverity('info'),
    notChecked: analysis.report.skipped.map((s) => ({ rule: s.rule, reason: s.reason })),
    crashed: analysis.report.crashed.map((s) => ({ rule: s.rule, reason: `crashed: ${s.reason}` })),
    cameBack: new Set(active.filter((f) => status(f) === 'came back').map((f) => f.key)),
    header: {
      robot: m.profile.name, event: m.event, matchLabel: m.matchLabel, date: matchDate(analysis), logFile: m.fileName,
      dsFiles: m.ds.map((d) => d.fileName), build: buildLine(m.build), version: VERSION,
    },
    bottomLine: '',
    jsonFile: findingsFileName(m), schema: SCHEMA,
  }
  // "Worst:" names a headline, not a finding shown under one (the counts still count every finding).
  const heads = new Set(fullHeadlines.map((n) => n.finding))
  const headlinesFirst = (list: Finding[]) => [...list.filter((f) => heads.has(f)), ...list.filter((f) => !heads.has(f))]
  // A parent as the worst headline names its group, and stands for the errors in the group (not those nested deeper).
  const worst = fullHeadlines.find((n) => n.finding.severity === 'error')
  const groupErrors = worst ? worst.children.filter((c) => c.finding.severity === 'error').length : 0
  const group = worst && parents.includes(worst.finding) ? { title: worst.finding.title, covers: groupErrors } : undefined
  model.bottomLine = bottomLine(headlinesFirst(model.errors), headlinesFirst(model.warnings), model.infos, known.length, group)
  return model
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The headlines of one severity, as the report lists them. */
export function headlinesOf(m: ReviewModel, s: Severity): FindingNode[] {
  return m.headlines.filter((n) => n.finding.severity === s)
}

/** How many active findings of this severity the report lists under a more serious headline (for its section count). */
export function listedAbove(m: ReviewModel, s: Severity): number {
  const here = new Set([...headlinesOf(m, s), ...m.standing.filter((n) => n.finding.severity === s)].flatMap((n) => [n.finding, ...descendants(n)]))
  return m.active.filter((f) => f.severity === s && !here.has(f)).length
}

/** `group`: the worst headline is a parent, standing for this many of the errors. */
export function bottomLine(errors: Finding[], warnings: Finding[], infos: Finding[], known: number, group?: { title: string; covers: number }): string {
  const tail = `${plural(warnings.length, 'warning')}, ${infos.length} info${known ? `, ${known} known` : ''}`
  const stop = (t: string) => (t.endsWith('…') ? t : `${t}.`)
  if (errors.length === 0) return warnings.length ? `No errors. ${tail}. Worst: ${stop(shortTitle(warnings[0].title))}` : `No errors or warnings. ${tail}.`
  const worst = group?.title ?? errors[0].title
  const rest = errors.length - (group?.covers ?? 1)
  const more = rest ? `; +${rest} more error${rest === 1 ? '' : 's'}.` : ''
  return `${plural(errors.length, 'error')}, ${tail}. Worst: ${rest ? shortTitle(worst) : stop(shortTitle(worst))}${more}`
}

/**
 * True when the title already says this number (not as part of a time like 2:27 or a longer number). A plain number
 * counts when the title holds one equal to it at the title's own precision, sign ignored: "-24°" says 23.7, "2.4 V"
 * says 2.37; "22.8 %" does not. Anything else (a string with text) must appear exactly.
 */
export function titleHasValue(title: string, value: number | string): boolean {
  const text = String(value).trim()
  const v = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`(?<![\\d.:])${v}(?![\\d:]|\\.\\d)`).test(title)) return true
  if (!/^[-+]?\d+(\.\d+)?$/.test(text)) return false
  const n = Math.abs(Number(text))
  for (const m of title.matchAll(/(?<![\d.:])(\d+)(?:\.(\d+))?(?![\d:]|\.\d)/g)) {
    const places = m[2]?.length ?? 0
    if (n.toFixed(places) === `${m[1]}${places ? `.${m[2]}` : ''}`) return true
  }
  return false
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

/** "1 error: <title>, 5 warnings": what the standing fold holds, as the Match tab's summary says it. */
export function standingSummary(m: ReviewModel): { errors: string[]; warnings: number; infos: number; first?: Finding } {
  const errs = m.standing.filter((n) => n.finding.severity === 'error').map((n) => n.finding)
  return {
    errors: errs.map((f) => cardTitle(f.title)),
    warnings: m.standing.filter((n) => n.finding.severity === 'warning').length,
    infos: m.standing.filter((n) => n.finding.severity === 'info').length,
    first: errs[0],
  }
}

/** ", including <first folded error>" for the card's note when the fold left no items; empty when none is an error. */
function foldedFirst(m: ReviewModel): string {
  const f = m.standing.find((n) => n.finding.severity === 'error')?.finding
  return f ? `, including ${cardTitle(f.title)}` : ''
}

/** "2:25 into the match" from "2:25 into the match (teleop; robot time 532.8 s)", for tight places. */
export function shortWhen(when: string | null): string {
  return when ? when.replace(/\s*\(.*$/, '') : ''
}

export function incidentFor(f: Finding): string {
  const r = makerOf(f.rule)
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
    // When the fold took every item, the note also names the first folded error, so the card still says what to fix.
    standingNote: m.standing.length ? `+ ${m.standing.length} in every match this session${worst.length ? '' : foldedFirst(m)}` : undefined,
    items: worst.map((n) => {
      const f = n.finding
      const k = keyNumber(f)
      const word = (m.errors.length ? 'ERROR' : 'WARNING') + (m.cameBack.has(f.key) ? ' · CAME BACK' : '')
      const under = descendants(n)
      const number = [k.inTitle ? '' : k.text, under.length ? `explains ${severityWords(under)}` : ''].filter(Boolean).join(' · ')
      return { word, tone, title: cardTitle(f.title), number }
    }),
    // "No new errors": true by construction, whereas "nothing new" was false when only the errors folded and new warnings stayed.
    emptyText: m.standing.length ? `No new ${tone}s in this match.` : 'Nothing to fix from this log.',
    footer: [h.build.text, `Hindsight ${h.version}`],
    uncommitted: h.build.uncommitted,
    uncommittedText: 'UNCOMMITTED CODE ran this match',
  }
}
