/**
 * Known issues: what the team has already seen, and what it did about it.
 *
 * An issue is a finding's `key` (the rule, plus what it is about: "mech/follower-mismatch · Flywheel"), so the same
 * problem in five matches is one issue. Marking it:
 *   known — we know, we're on it (or living with it): it moves out of the red list into "Known issues"
 *   fixed — we fixed it: if it fires again it shows as "came back after a fix", at the top
 *   wrong — not a real problem, with the reason ("deliberate A-stop"). Unlike known and fixed, this is about one match
 *           only: the same check on another match may be right. Other matches of the same event show the check's
 *           reds as amber while the mark stands (track-record.ts).
 *   real  — a real problem on this match, with an optional note (what happened, a link to the report). Also about
 *           one match only, and it changes nothing on the page: the finding stays where it was, red stays red. It is
 *           what the check's "How sure" line counts as confirmed. (A known mark would confirm too, but it files every
 *           later fire of the issue as known, which hides reds for a check with no subject, like comms/loss.)
 *   unmark — undo a wrong or real mark on its match only. (Not "new": a build from before wrong marks skips this line, but
 *           would read "new" as clearing the issue's known or fixed mark.)
 *   new   — undo: treat it as new again, on every match.
 *
 * The record is a text file, one JSON line per change (hindsight-history.jsonl). Lines only get added, so two
 * laptops' files can be combined by putting one after the other; for each issue the newest line wins.
 * The page also keeps a copy in the browser so a reload doesn't lose it. Save the file to share it.
 */

export type IssueStatus = 'known' | 'fixed' | 'wrong' | 'real' | 'unmark' | 'new'

export interface IssueEvent {
  type: 'issue'
  key: string
  status: IssueStatus
  note: string
  /** When the change was made (ISO time). */
  when: string
  /** The match it was marked on ("<event> <match label>", or the log's file name when it has neither). A wrong or real mark always has one. */
  match?: string
  /** The match's event name, as the Driver Station logged it (absent in files written before wrong marks). */
  event?: string
  /** When that match was played (ISO time), so the same event name next year is a different event. */
  played?: string
}

/**
 * A Foresight pit check (the live check before queuing) that reached a verdict: which code it saw, and the verdict.
 * foresight/commit-matches compares the robot's code with the last one that came out GO.
 */
export interface PitCheckEvent {
  type: 'pit-check'
  verdict: 'GO' | 'NO-GO' | 'NOT CHECKED'
  /** The robot's GitSHA and whether it had uncommitted changes. */
  sha: string
  dirty: boolean
  /** The robot profile used, e.g. "2026 offseason robot @ the event branch". */
  robot: string
  when: string
}

/**
 * A well-formed JSON line this build cannot type (a newer build's line, such as the issue board's). It is never folded;
 * it is kept so that saving the file writes the line back exactly as it came.
 */
export interface OpaqueEvent {
  type: 'opaque'
  raw: string
  when: string
}

export type HistoryEvent = IssueEvent | PitCheckEvent | OpaqueEvent

export const HISTORY_FILE_NAME = 'hindsight-history.jsonl'

/** Read a history file. A JSON object line this build can't type is kept as an OpaqueEvent; `skipped` counts only
 * lines that aren't JSON objects. Never fatal. */
export function parseHistory(text: string): { events: HistoryEvent[]; skipped: number } {
  const events: HistoryEvent[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      const isObject = typeof e === 'object' && e !== null && !Array.isArray(e)
      if (!isObject) skipped++
      else if (e.type === 'issue' && typeof e.key === 'string' && ['known', 'fixed', 'new'].includes(e.status)) events.push({ note: '', when: '', ...e })
      else if (e.type === 'issue' && typeof e.key === 'string' && ['wrong', 'real', 'unmark'].includes(e.status) && typeof e.match === 'string' && e.match) events.push({ note: '', when: '', ...e })
      else if (e.type === 'pit-check' && typeof e.sha === 'string' && ['GO', 'NO-GO', 'NOT CHECKED'].includes(e.verdict)) events.push({ dirty: false, robot: '', when: '', ...e })
      else events.push({ type: 'opaque', raw: line, when: typeof e.when === 'string' ? e.when : '' })
    } catch {
      skipped++
    }
  }
  return { events, skipped }
}

export function serializeHistory(events: HistoryEvent[]): string {
  return events.map((e) => (e.type === 'opaque' ? e.raw : JSON.stringify(e))).join('\n') + (events.length ? '\n' : '')
}

/** Combine two lists of events, dropping exact duplicates (the same file loaded twice). */
export function mergeHistory(a: HistoryEvent[], b: HistoryEvent[]): HistoryEvent[] {
  const seen = new Set(a.map((e) => JSON.stringify(e)))
  return [...a, ...b.filter((e) => !seen.has(JSON.stringify(e)))].sort((x, y) => x.when.localeCompare(y.when))
}

/** Each issue's latest known or fixed mark (issues marked "new" again are left out). Wrong marks are per match: see `triage`. */
export function currentStatus(events: HistoryEvent[]): Map<string, IssueEvent> {
  return triage(events).issues
}

export interface Triage {
  /** Each issue's latest known or fixed mark, for every match it fires in. */
  issues: Map<string, IssueEvent>
  /** Wrong marks still standing, by `matchKey(issue, match)`. */
  wrong: Map<string, IssueEvent>
  /** Real marks still standing, by `matchKey(issue, match)`. */
  real: Map<string, IssueEvent>
}

export const matchKey = (key: string, match: string) => `${key}\u0000${match}`

/**
 * Replay the marks oldest first. Known and fixed apply to the issue in every match; a wrong or real mark applies to its
 * own match, and only a later mark of the same issue on that same match changes it (wrong and real replace each other;
 * known or fixed: it was real after all; unmark: undo just the wrong or real mark; new: the issue is new again
 * everywhere, and on that match).
 */
export function triage(events: HistoryEvent[]): Triage {
  const issues = new Map<string, IssueEvent>()
  const wrong = new Map<string, IssueEvent>()
  const real = new Map<string, IssueEvent>()
  for (const e of [...events].sort((x, y) => x.when.localeCompare(y.when))) {
    if (e.type !== 'issue') continue
    const here = e.match ? matchKey(e.key, e.match) : null
    if (here) wrong.delete(here)
    if (e.status === 'wrong') { real.delete(here!); wrong.set(here!, e); continue }
    if (e.status === 'real') { real.set(here!, e); continue }
    if (here && (e.status === 'unmark' || e.status === 'new')) real.delete(here)
    if (e.status === 'unmark') continue
    if (e.status === 'new') issues.delete(e.key)
    else issues.set(e.key, e)
  }
  return { issues, wrong, real }
}

/** The code of the latest pit check that came out GO (null if none is on record). */
export function lastPassingSha(events: HistoryEvent[]): string | null {
  const go = events.filter((e): e is PitCheckEvent => e.type === 'pit-check' && e.verdict === 'GO' && e.sha !== '')
  return go.sort((x, y) => x.when.localeCompare(y.when)).at(-1)?.sha ?? null
}
