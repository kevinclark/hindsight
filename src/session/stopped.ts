/**
 * Findings that stopped firing in a session's later matches.
 *
 * A student's "fixed" mark comes first: "Marked fixed after Q4 · quiet in 3 checked matches since". It counts the
 * matches played after the mark where the rule could look and this issue didn't fire. No statistics: the mark is a
 * known moment of change, made by the person who did the repair.
 *
 * With no mark, a rule whose last firing is followed by at least 2 checked matches, every one quiet, is "not seen
 * since" that match (the rule's own row in the rule × match grid). How often a run that clean happens with no fix:
 * with k firings across N checked matches, the last at checked match n, it is C(n, k) / C(N, k), the chance that all
 * k land in the first n when the matches are interchangeable (an exact one-sided permutation test). At 0.05 or less
 * it reads "potentially fixed", and a warning then sorts below the live findings; an error never does. Never plain
 * "fixed": the log can't see a pit repair. Matches the rule couldn't check are skipped, never counted as clean.
 */

import type { IssueEvent } from '../triage/history.ts'
import type { Severity } from '../rules/types.ts'
import type { MatchSummary } from './summary.ts'
import type { MergedFinding, Session } from './session.ts'
import { shortMatchLabel } from '../ui/match-label.ts'

/** "Potentially fixed" only when a run this clean happens this rarely with no fix. */
export const POTENTIALLY_FIXED_AT = 0.05
/** "Not seen since" needs at least this many checked matches after the last firing. */
export const MIN_CLEAN = 2

export interface CodeChange { from: string; to: string }

export interface NotSeenSince {
  kind: 'not seen'
  /** The rule's last firing, by index into session.matches. */
  last: number
  /** Checked matches after it, every one quiet. */
  clean: number
  /** The chance of a run this clean with no fix, C(n, k) / C(N, k): `times` in `outOf`, in lowest terms. */
  times: number
  outOf: number
  chance: number
  /** 1 / chance, rounded: "about 1 time in `about`" when `outOf` is too big to say. */
  about: number
  /** The chance is 0.05 or less. */
  potentiallyFixed: boolean
  /** The log's own build differs between the last firing and the next clean match. */
  codeChanged?: CodeChange
}

export interface SinceFixed {
  kind: 'fixed mark'
  /** The last match played before the mark, by index into session.matches (null when none was). */
  before: number | null
  /** Matches played after the mark where the rule looked and this issue didn't fire. */
  quiet: number
  codeChanged?: CodeChange
}

export type Stopped = NotSeenSince | SinceFixed

/**
 * Has this finding stopped firing? The issue's fixed mark leads; when it fired again after the mark (the view's
 * "Came back after a fix"), nothing is said here.
 */
export function stoppedFiring(session: Session, f: Pick<MergedFinding, 'key' | 'rule' | 'matches'>, issue?: IssueEvent): Stopped | null {
  if (issue?.status === 'fixed') return sinceFixedMark(session, f, issue)
  return notSeenSince(session, f.rule)
}

/** A warning (never an error) that is potentially fixed sorts below the live findings. */
export function sinks(stopped: Stopped | null, severity: Severity): boolean {
  return stopped?.kind === 'not seen' && stopped.potentiallyFixed && severity !== 'error'
}

/** The rule's row of the grid, with no mark: "not seen since" its last firing, or null. */
export function notSeenSince(session: Session, rule: string): NotSeenSince | null {
  const cells = session.matches.map((m) => m.rules[rule]?.status ?? 'not checked')
  const checked = cells.flatMap((c, i) => (c === 'not checked' ? [] : [i]))
  const fired = checked.filter((i) => cells[i] === 'fired')
  const last = fired.at(-1)
  if (last === undefined) return null
  const n = checked.indexOf(last) + 1
  const clean = checked.length - n
  if (clean < MIN_CLEAN) return null
  const run = cleanRunChance(n, fired.length, checked.length)
  return { kind: 'not seen', last, clean, ...run, codeChanged: codeChange(session.matches, last, checked[n]) }
}

/** After a fixed mark: the matches since it where the rule looked and this issue stayed quiet. Null if it came back. */
export function sinceFixedMark(session: Session, f: Pick<MergedFinding, 'key' | 'rule' | 'matches'>, issue: IssueEvent): SinceFixed | null {
  const markedAt = Date.parse(issue.when)
  if (Number.isNaN(markedAt)) return null
  const all = session.matches.map((_, i) => i)
  const played = (i: number) => session.matches[i].playedAt
  // The same test as "came back": played after the mark.
  const after = all.filter((i) => played(i) !== null && played(i)! > markedAt)
  if (f.matches.some((i) => after.includes(i))) return null
  const before = all.filter((i) => played(i) !== null && played(i)! <= markedAt).at(-1) ?? null
  const quiet = after.filter((i) => lookedFor(session.matches[i], f))
  const lastFired = f.matches.filter((i) => !after.includes(i)).at(-1)
  return { kind: 'fixed mark', before, quiet: quiet.length, codeChanged: codeChange(session.matches, lastFired, quiet[0]) }
}

/** The rule looked at this issue in this match: it wasn't "not checked" there, nor was the issue's own item. */
function lookedFor(m: MatchSummary, f: Pick<MergedFinding, 'key' | 'rule'>): boolean {
  const r = m.rules[f.rule]
  if (!r || r.status === 'not checked') return false
  // A rule that checks each motor or camera names the ones it skipped: "partly checked; Hood: never moved".
  const about = f.key === f.rule ? null : f.key.slice(f.rule.length + ' · '.length)
  return !(about && r.reason?.split('; ').some((part) => part.startsWith(`${about}: `)))
}

/** The build each log says it ran, when it differs between these two matches. */
function codeChange(matches: MatchSummary[], a: number | undefined, b: number | undefined): CodeChange | undefined {
  const from = a === undefined ? '' : matches[a].build?.sha ?? ''
  const to = b === undefined ? '' : matches[b].build?.sha ?? ''
  return from && to && from !== to ? { from, to } : undefined
}

/**
 * C(n, k) / C(N, k): with k firings among N checked matches placed at random, the chance that all of them fall in
 * the first n. Exact (big integers), in lowest terms; `potentiallyFixed` compares the fractions, not rounded numbers.
 */
export function cleanRunChance(n: number, k: number, total: number): { times: number; outOf: number; chance: number; about: number; potentiallyFixed: boolean } {
  const a = binomial(n, k)
  const b = binomial(total, k)
  const g = gcd(a, b)
  return {
    times: Number(a / g),
    outOf: Number(b / g),
    // Both as plain numbers: exact enough for any session (a 1e-30 chance stays 1e-30, never 0).
    chance: Number(a) / Number(b),
    about: Number((b + a / 2n) / a),
    potentiallyFixed: a * BigInt(Math.round(1 / POTENTIALLY_FIXED_AT)) <= b,
  }
}

function binomial(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n
  let c = 1n
  for (let i = 0; i < k; i++) c = (c * BigInt(n - i)) / BigInt(i + 1)
  return c
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b]
  return a
}

/** "1 time in 35", "3 times in 7"; past 1000 in the denominator, "about 1 time in 1,234"; "fewer than 1 time in a billion". */
export function chanceText(s: Pick<NotSeenSince, 'times' | 'outOf' | 'about'>): string {
  if (s.about > 1e9) return 'fewer than 1 time in a billion'
  if (s.outOf > 1000) return `about 1 time in ${s.about.toLocaleString('en-US')}`
  return `${s.times} time${s.times === 1 ? '' : 's'} in ${s.outOf}`
}

/**
 * The finding's line in the Session view, the report and the JSON: "Not seen since Q4 · 3 clean checked matches · a
 * run this clean happens 4 times in 7 with no fix", or "Marked fixed after Q4 · quiet in 3 checked matches since".
 */
export function stoppedText(session: Session, s: Stopped, f?: Pick<MergedFinding, 'matches'>): string {
  const code = s.codeChanged ? ` · code changed in between: ${s.codeChanged.from} → ${s.codeChanged.to}` : ''
  if (s.kind === 'fixed mark') {
    const since = s.quiet ? `quiet in ${s.quiet} checked match${s.quiet === 1 ? '' : 'es'} since` : 'no match checked since'
    return `Marked fixed${s.before === null ? '' : ` after ${matchName(session, s.before)}`} · ${since}${code}`
  }
  const clean = `${s.clean} clean checked match${s.clean === 1 ? '' : 'es'}`
  // The run is the rule's own row; this issue may have last fired earlier than the rule did.
  const own = f?.matches.at(-1)
  const ownLast = own !== undefined && own !== s.last ? ` (this one last in ${matchName(session, own)})` : ''
  const since = `${s.potentiallyFixed ? 'Potentially fixed: not' : 'Not'} seen since ${matchName(session, s.last)}${ownLast}`
  return `${since} · ${clean} · a run this clean happens ${chanceText(s)} with no fix${code}`
}

/** For the bottom line and the card: "not seen since Q4, 1 in 35", the chance with no-break spaces so it never wraps. */
export function stoppedShort(session: Session, s: NotSeenSince): string {
  const chance = chanceText(s).replace(/ times? in /, ' in ').replace(/ /g, '\u00a0')
  return `not seen since ${matchName(session, s.last)}, ${chance}`
}

/**
 * For the phone card, only what is worth its room: "potentially fixed: not seen since Q4, 1 in 35" (errors too), or
 * "marked fixed after Q4, quiet in 3 since". A plain "not seen since" (weaker than 1 in 20) stays off. Empty otherwise.
 */
export function stoppedCard(session: Session, s: Stopped | null): string {
  if (s?.kind === 'fixed mark') {
    const after = s.before === null ? 'marked fixed' : `marked fixed after ${matchName(session, s.before)}`
    return `${after}, ${s.quiet ? `quiet in ${s.quiet} since` : 'no match checked since'}`
  }
  return s?.potentiallyFixed ? `potentially fixed: ${stoppedShort(session, s)}` : ''
}

const matchName = (session: Session, i: number) => shortMatchLabel(session.matches[i].matchLabel, i)
