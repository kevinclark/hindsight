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

export type BoardOp = 'priority' | 'status' | 'defer' | 'workaround' | 'note'
export type BoardRole = 'software' | 'pit' | 'drive' | 'mentor'

export interface BoardUntil {
  kind: 'next-match' | 'gap' | 'before-elims' | 'end-of-event' | 'next-event'
  match?: string
  matches?: number
  minutes?: number
}

/**
 * One change to the issue board (priority, status, deferral, workaround, note) for one issue on one robot. A new line
 * type, not new fields on `issue`: builds from before the board keep it unread (an OpaqueEvent, written back as it came,
 * and a file loaded in analyze.ts does not report it), and every `issue` line folds as it always did. "Closed" is never stored; it is derived from a clean match after the fix. No names go in a line.
 */
export interface BoardEvent {
  type: 'board'
  /** Bump when a line old builds must not fold; adding a value to priority or status makes old builds keep the line without folding it. */
  v: 1
  /** The issue key as `IssueEvent.key`: "rule · about". */
  key: string
  /** The robot's profile id, or the name `summaryRobot()` gives; '' = unknown. */
  robot: string
  op: BoardOp
  /** priority: high|medium|low; status: open|fixing|check; defer: any non-empty value sets a deferral (its text is not kept; the target is `until`); '' with no until clears;
   * workaround and note: free text. */
  value: string
  /** Only on op 'defer'. */
  until?: BoardUntil
  match?: string
  event?: string
  played?: string
  /** sha256 of the log the change was made on. */
  log?: string
  by: { device: string; role: BoardRole }
  /** Per device, increasing: 1 + the largest seq this device has in the history, so two tabs can't repeat one. */
  seq: number
  when: string
}

/**
 * A well-formed JSON line this build cannot type (a newer build's line, or a known type that fails its checks). It is
 * never folded; it is kept so that saving the file writes the line back exactly as it came.
 */
export interface OpaqueEvent {
  type: 'opaque'
  raw: string
  when: string
}

export type HistoryEvent = IssueEvent | PitCheckEvent | BoardEvent | OpaqueEvent

const BOARD_OPS: readonly string[] = ['priority', 'status', 'defer', 'workaround', 'note']
const BOARD_ROLES: readonly string[] = ['software', 'pit', 'drive', 'mentor']
const BOARD_VALUES: Partial<Record<BoardOp, readonly string[]>> = { priority: ['high', 'medium', 'low'], status: ['open', 'fixing', 'check'] }
const UNTIL_KINDS: readonly string[] = ['next-match', 'gap', 'before-elims', 'end-of-event', 'next-event']

function validBoard(e: any): boolean {
  if (e.v !== 1 || typeof e.key !== 'string' || typeof e.robot !== 'string' || typeof e.value !== 'string') return false
  if (!BOARD_OPS.includes(e.op)) return false
  const allowed = BOARD_VALUES[e.op as BoardOp]
  if (allowed && !allowed.includes(e.value)) return false
  if (e.op === 'defer' && e.value === '' && e.until !== undefined) return false
  if (e.op === 'defer' && e.until !== undefined && !(e.until && UNTIL_KINDS.includes(e.until.kind))) return false
  if (!e.by || typeof e.by.device !== 'string' || !BOARD_ROLES.includes(e.by.role)) return false
  return Number.isFinite(e.seq) && typeof e.when === 'string'
}

/** Oldest first: by time, then device, then seq (old lines have device '' and seq 0). Ties otherwise keep file order. */
export function compareEvents(x: HistoryEvent, y: HistoryEvent): number {
  const dx = x.type === 'board' ? x.by.device : ''
  const dy = y.type === 'board' ? y.by.device : ''
  const sx = x.type === 'board' ? x.seq : 0
  const sy = y.type === 'board' ? y.seq : 0
  return x.when.localeCompare(y.when) || (dx < dy ? -1 : dx > dy ? 1 : 0) || sx - sy
}

export const HISTORY_FILE_NAME = 'hindsight-history.jsonl'

/** Read a history file. A JSON object line this build can't type is kept as an OpaqueEvent;
 * `skipped` counts only lines that aren't JSON objects. Never fatal. */
export function parseHistory(text: string): { events: HistoryEvent[]; skipped: number } {
  const events: HistoryEvent[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      const isObject = typeof e === 'object' && e !== null && !Array.isArray(e)
      if (isObject && e.type === 'issue' && typeof e.key === 'string' && ['known', 'fixed', 'new'].includes(e.status)) events.push({ note: '', when: '', ...e })
      else if (isObject && e.type === 'issue' && typeof e.key === 'string' && ['wrong', 'real', 'unmark'].includes(e.status) && typeof e.match === 'string' && e.match) events.push({ note: '', when: '', ...e })
      else if (isObject && e.type === 'pit-check' && typeof e.sha === 'string' && ['GO', 'NO-GO', 'NOT CHECKED'].includes(e.verdict)) events.push({ dirty: false, robot: '', when: '', ...e })
      else if (isObject && e.type === 'board' && validBoard(e)) events.push(e)
      else if (isObject) events.push({ type: 'opaque', raw: line, when: typeof e.when === 'string' ? e.when : '' })
      else skipped++
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
  return [...a, ...b.filter((e) => !seen.has(JSON.stringify(e)))].sort(compareEvents)
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
  for (const e of [...events].sort(compareEvents)) {
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
  return go.sort(compareEvents).at(-1)?.sha ?? null
}

export interface BoardState {
  key: string
  robot: string
  priority?: string
  status?: string
  /** The latest deferral; absent when none was set or the last defer line cleared it. */
  deferred?: { until?: BoardUntil; by: BoardEvent['by']; when: string }
  workaround?: string
  /** Every note, oldest first. */
  notes: { text: string; by: BoardEvent['by']; when: string }[]
  /** Who made the latest change, and when. */
  by: BoardEvent['by']
  when: string
}

export const boardKey = (key: string, robot: string) => `${key}\u0000${robot}`

/** Replay the board lines oldest first: the latest priority, status, deferral and workaround per (issue, robot), all notes. */
export function boardState(events: HistoryEvent[]): Map<string, BoardState> {
  const out = new Map<string, BoardState>()
  for (const e of [...events].sort(compareEvents)) {
    if (e.type !== 'board') continue
    const k = boardKey(e.key, e.robot)
    const s = out.get(k) ?? { key: e.key, robot: e.robot, notes: [], by: e.by, when: e.when }
    if (e.op === 'priority') s.priority = e.value
    else if (e.op === 'status') s.status = e.value
    else if (e.op === 'defer') {
      if (e.value === '') delete s.deferred
      else s.deferred = { ...(e.until ? { until: e.until } : {}), by: e.by, when: e.when }
    } else if (e.op === 'workaround') s.workaround = e.value
    else s.notes.push({ text: e.value, by: e.by, when: e.when })
    s.by = e.by
    s.when = e.when
    out.set(k, s)
  }
  return out
}
