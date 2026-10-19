/**
 * Known issues: what the team has already seen, and what it did about it.
 *
 * An issue is a finding's `key` (the rule, plus what it is about: "mech/follower-mismatch · Flywheel"), so the same
 * problem in five matches is one issue. Marking it:
 *   known — we know, we're on it (or living with it): it moves out of the red list into "Known issues"
 *   fixed — we fixed it: if it fires again it shows as "came back after a fix", at the top
 *   new   — undo: treat it as new again
 *
 * The record is a text file, one JSON line per change (hindsight-history.jsonl). Lines only get added, so two
 * laptops' files can be combined by putting one after the other; for each issue the newest line wins.
 * The page also keeps a copy in the browser so a reload doesn't lose it. Save the file to share it.
 */

export type IssueStatus = 'known' | 'fixed' | 'new'

export interface IssueEvent {
  type: 'issue'
  key: string
  status: IssueStatus
  note: string
  /** When the change was made (ISO time). */
  when: string
  /** The match it was marked on, for context. */
  match?: string
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
  /** The robot profile used, e.g. "2026 offseason robot @ event-calgames". */
  robot: string
  when: string
}

export type HistoryEvent = IssueEvent | PitCheckEvent

export const HISTORY_FILE_NAME = 'hindsight-history.jsonl'

/** Read a history file. Lines that aren't issue or pit-check events are skipped and counted, never fatal. */
export function parseHistory(text: string): { events: HistoryEvent[]; skipped: number } {
  const events: HistoryEvent[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'issue' && typeof e.key === 'string' && ['known', 'fixed', 'new'].includes(e.status)) events.push({ note: '', when: '', ...e })
      else if (e.type === 'pit-check' && typeof e.sha === 'string' && ['GO', 'NO-GO', 'NOT CHECKED'].includes(e.verdict)) events.push({ dirty: false, robot: '', when: '', ...e })
      else skipped++
    } catch {
      skipped++
    }
  }
  return { events, skipped }
}

export function serializeHistory(events: HistoryEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '')
}

/** Combine two lists of events, dropping exact duplicates (the same file loaded twice). */
export function mergeHistory(a: HistoryEvent[], b: HistoryEvent[]): HistoryEvent[] {
  const seen = new Set(a.map((e) => JSON.stringify(e)))
  return [...a, ...b.filter((e) => !seen.has(JSON.stringify(e)))].sort((x, y) => x.when.localeCompare(y.when))
}

/** Each issue's latest event (issues marked "new" again are left out). */
export function currentStatus(events: HistoryEvent[]): Map<string, IssueEvent> {
  const latest = new Map<string, IssueEvent>()
  for (const e of [...events].sort((x, y) => x.when.localeCompare(y.when))) if (e.type === 'issue') latest.set(e.key, e)
  for (const [key, e] of latest) if (e.status === 'new') latest.delete(key)
  return latest
}

/** The code of the latest pit check that came out GO (null if none is on record). */
export function lastPassingSha(events: HistoryEvent[]): string | null {
  const go = events.filter((e): e is PitCheckEvent => e.type === 'pit-check' && e.verdict === 'GO' && e.sha !== '')
  return go.sort((x, y) => x.when.localeCompare(y.when)).at(-1)?.sha ?? null
}
