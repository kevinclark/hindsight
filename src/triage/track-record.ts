/**
 * What the team's marks say about a check: its track record on our matches, and whether a "not a real problem" mark
 * on one match of an event should turn its reds amber on the others.
 *
 * Nothing here acts without a history: with no marks, every finding keeps its severity and no "How sure" line shows.
 *
 * Track record, per check (rule), counted once per issue per match (an issue is a finding's `key`), so a check that
 * fires on four motors in one match counts four times:
 *   fired     — every open log (Match review and Session) where it gave a warning or an error, plus every match named
 *               on a mark of it in the history, since the history outlives the logs
 *   real      — someone marked the issue known or fixed on that very match (and it still is)
 *   known     — another match of an issue that is marked known, or fixed after that match was played: nobody looked at
 *               this one, so it is not counted as confirmed
 *   wrong     — marked "not a real problem" on that match
 *   untriaged — the rest, including a fire after a fix (it came back: is the fix wrong, or the check?)
 */

import type { Analysis } from '../analyze.ts'
import type { Finding } from '../rules/types.ts'
import { RULES } from '../rules/index.ts'
import { worstFirst } from '../rules/run.ts'
import { shortMatchLabel } from '../ui/match-label.ts'
import { findingStatus } from '../report/review-model.ts'
import { explainerOf } from '../report/finding-tree.ts'
import { matchKey, type HistoryEvent, type IssueEvent, type Triage } from './history.ts'
import type { Session } from '../session/session.ts'
import type { MatchSummary, SummaryFinding } from '../session/summary.ts'

/** A match as marks name it. `id` is what a mark's `match` holds. */
export interface MatchRef {
  id: string
  event: string
  /** When it was played (ms since 1970), or null when the log doesn't say. */
  played: number | null
}

export function matchRef(m: { event: string; matchLabel: string; fileName: string }, played: number | null): MatchRef {
  // With no match label, the event name alone would name every such log of the event: use the file.
  return { id: m.matchLabel ? `${m.event} ${m.matchLabel}`.trim() : m.fileName, event: m.event, played }
}

export const ruleOf = (key: string) => key.split(' · ')[0]

/** "Q24" from a mark's "<event> Qualification 24" (the event name dropped), for short notes. */
export function shortMatch(mark: IssueEvent): string {
  const id = mark.match ?? ''
  const label = mark.event && id.startsWith(`${mark.event} `) ? id.slice(mark.event.length + 1) : id
  return /\d$/.test(label) ? shortMatchLabel(label, 0) : label
}

/** A finding that fired in an open log, and when its match was played (ms, null if unknown). */
export interface Fire { key: string; match: string; played: number | null }

export interface TrackRecord { fired: number; real: number; known: number; wrong: number; untriaged: number }

export function trackRecord(rule: string, t: Triage, events: HistoryEvent[], fires: Fire[]): TrackRecord {
  const seen = new Map<string, Fire>()
  const add = (f: Fire) => { if (ruleOf(f.key) === rule) seen.set(matchKey(f.key, f.match), f) }
  for (const f of fires) add(f)
  const markedReal = new Set<string>()
  for (const e of events) {
    if (e.type !== 'issue' || e.status === 'new' || e.status === 'unmark' || !e.match) continue
    if (!seen.has(matchKey(e.key, e.match))) add({ key: e.key, match: e.match, played: null })
    if (e.status === 'known' || e.status === 'fixed') markedReal.add(matchKey(e.key, e.match))
  }
  const r: TrackRecord = { fired: seen.size, real: 0, known: 0, wrong: 0, untriaged: 0 }
  for (const [mk, f] of seen) {
    const issue = t.issues.get(f.key)
    if (t.wrong.has(mk)) r.wrong++
    else if (issue && markedReal.has(mk)) r.real++
    else if (issue && (issue.status === 'known' || f.played === null || f.played < Date.parse(issue.when))) r.known++
    else r.untriaged++
  }
  return r
}

/** The one "How sure" line for a finding of this check; null when the history holds no marks at all (nothing to go on). */
export function howSure(r: TrackRecord, anyMarks: boolean): string | null {
  if (!anyMarks) return null
  const rest = [
    r.known ? `a known issue on ${r.known} more` : '',
    r.wrong ? `${r.wrong} marked not a real problem` : '',
    r.untriaged ? `${r.untriaged} not marked yet` : '',
  ].filter(Boolean).join('; ')
  const times = (n: number) => `${n} time${n === 1 ? '' : 's'}`
  if (r.real === 0 && r.wrong === 0) return `New check: never confirmed on our matches${r.fired ? ` (fired ${times(r.fired)}${rest ? `: ${rest}` : ''})` : ''}`
  return `marked real on ${r.real} of the ${times(r.fired)} it fired on our matches${rest ? `; ${rest}` : ''}`
}

const DAY = 86400e3

/**
 * The wrong mark that turns this red amber, if any: the same check marked "not a real problem" on another match of
 * the same event (same event name, played within 4 days of the marked match), the newest such mark. A finding the
 * team filed itself (known, fixed after this match, or wrong here) keeps that meaning instead; one that came back
 * after a fix can be demoted, since the fix may be fine and the check wrong. Only reds are demoted.
 */
export function demotion(f: Pick<Finding, 'key' | 'rule' | 'severity'>, here: MatchRef, t: Triage): IssueEvent | undefined {
  if (f.severity !== 'error' || !here.event || here.played === null) return undefined
  const filed = findingStatus(f, t.issues, here.played, wrongHere(here, t))
  if (filed && filed !== 'came back') return undefined
  const sameEvent = (e: IssueEvent) => {
    const played = e.played ? Date.parse(e.played) : NaN
    return e.event === here.event && !Number.isNaN(played) && Math.abs(played - here.played!) < 4 * DAY
  }
  return [...t.wrong.values()]
    .filter((e) => ruleOf(e.key) === f.rule && e.match !== here.id && sameEvent(e))
    .sort((a, b) => a.when.localeCompare(b.when))
    .at(-1)
}

/**
 * The analysis as the team's marks show it: reds demoted by a wrong mark on another match become amber, with the
 * reason, and take their place among the warnings. A parent is as serious as its worst member (run.ts parentOf), so
 * a red parent whose members are all demoted is demoted with them.
 */
export function withMarks(analysis: Analysis, here: MatchRef, t: Triage): Analysis {
  if (t.wrong.size === 0) return analysis
  const demote = (f: Finding, by: { match: string; reason: string; when: string }): Finding => ({ ...f, severity: 'warning', demoted: by })
  const mark = (f: Finding): Finding => {
    const by = demotion(f, here, t)
    return by ? demote(f, { match: shortMatch(by), reason: by.note, when: by.when }) : f
  }
  const findings = analysis.report.findings.map(mark)
  if (findings.every((f, i) => f === analysis.report.findings[i])) return analysis
  const parents = analysis.report.parents?.map(mark).map((p) => {
    const members = findings.filter((f) => explainerOf(f, [p]) === p)
    const by = members.find((f) => f.demoted)?.demoted
    return p.severity === 'error' && by && !members.some((f) => f.severity === 'error') ? demote(p, by) : p
  })
  findings.sort(worstFirst(RULES))
  return { ...analysis, report: { ...analysis.report, findings, ...(parents ? { parents } : {}) } }
}

/**
 * A session as the team's marks show it, match by match, with the same test as withMarks: a finding marked "not a real
 * problem" on its own match carries that mark, and a red that a wrong mark on another match of the event demotes is
 * amber, with the reason. Which matches a finding fired in is unchanged.
 */
export function sessionWithMarks(session: Session, t: Triage): Session {
  if (t.wrong.size === 0) return session
  return { ...session, matches: session.matches.map((m) => summaryWithMarks(m, t)) }
}

function summaryWithMarks(m: MatchSummary, t: Triage): MatchSummary {
  const here = matchRef(m, m.playedAt)
  const wrong = wrongHere(here, t)
  const mark = (f: SummaryFinding): SummaryFinding => {
    const w = wrong.get(f.key)
    if (w) return { ...f, wrongMark: { reason: w.note, when: w.when } }
    const by = demotion(f, here, t)
    return by ? { ...f, severity: 'warning', demoted: { match: shortMatch(by), reason: by.note, when: by.when } } : f
  }
  const rules = Object.fromEntries(Object.entries(m.rules).map(([id, r]) => [id, { ...r, findings: r.findings.map(mark) }]))
  return { ...m, rules }
}

/** The wrong marks standing on this match, by issue key. */
export function wrongHere(here: MatchRef, t: Triage): Map<string, IssueEvent> {
  return new Map([...t.wrong.values()].filter((e) => e.match === here.id).map((e) => [e.key, e]))
}
