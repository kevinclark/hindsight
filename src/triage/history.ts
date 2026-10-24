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
  /** 'GO WITH DEFERRALS': a queue check that was a go with deferrals open (never plain GO, ADR 9). An old build keeps the line as an OpaqueEvent and writes it back as it came. */
  verdict: 'GO' | 'GO WITH DEFERRALS' | 'NO-GO' | 'NOT CHECKED'
  /** The robot's GitSHA and whether it had uncommitted changes. */
  sha: string
  dirty: boolean
  /** The robot profile used, e.g. "2026 offseason robot @ the event branch". */
  robot: string
  when: string
}

export type BoardOp = 'priority' | 'status' | 'defer' | 'workaround' | 'note' | 'checked' | 'unchecked' | 'owner'
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
 * and a file loaded in analyze.ts does not report it), and every `issue` line folds as it always did. "Closed" is
 * never stored; it is derived from a clean match after the fix. No names go in a line.
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
   * workaround and note: free text; checked: the match it was checked for ("Q41"), a tick on the queue sheet (new op: an old build keeps
   * the line unread and writes it back as it came); unchecked: the same shape, takes a tick back (a tick counts only if no later unchecked names its match); owner: software|pit|drive, '' clears (the role that owns the issue; also a new op). */
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

export type EventNoteKind = 'pit-change' | 'missed' | 'handoff-read'

/**
 * A note about the event rather than one issue: what the team changed in the pit (the latest per match wins), something
 * Hindsight missed, or a handoff read. A new line type: old builds keep it as an OpaqueEvent and write it back unchanged.
 * No names go in a line; `by` is a device and a role.
 */
export interface EventNote {
  type: 'event-note'
  v: 1
  kind: EventNoteKind
  /** The event's TBA key, or the session's event name when there is no key. */
  event: string
  /** The latest match when the note was written ("Q33"); '' when there is none. */
  match: string
  /** '' for handoff-read. */
  text: string
  by: { device: string; role: BoardRole }
  /** Per device, increasing, counted with the device's board lines (boardStamp). */
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

export type HistoryEvent = IssueEvent | PitCheckEvent | BoardEvent | EventNote | OpaqueEvent

const BOARD_OPS: readonly string[] = ['priority', 'status', 'defer', 'workaround', 'note', 'checked', 'unchecked', 'owner']
const NOTE_KINDS: readonly string[] = ['pit-change', 'missed', 'handoff-read']
const BOARD_ROLES: readonly string[] = ['software', 'pit', 'drive', 'mentor']
const BOARD_VALUES: Partial<Record<BoardOp, readonly string[]>> = { priority: ['high', 'medium', 'low'], status: ['open', 'fixing', 'check'], owner: ['software', 'pit', 'drive', ''] }
const UNTIL_KINDS: readonly string[] = ['next-match', 'gap', 'before-elims', 'end-of-event', 'next-event']

function validBoard(e: any): boolean {
  if (e.v !== 1 || typeof e.key !== 'string' || typeof e.robot !== 'string' || typeof e.value !== 'string') return false
  if (!BOARD_OPS.includes(e.op)) return false
  const allowed = BOARD_VALUES[e.op as BoardOp]
  if (allowed && !allowed.includes(e.value)) return false
  if ((e.op === 'checked' || e.op === 'unchecked') && e.value === '') return false
  if (e.op === 'defer' && e.value === '' && e.until !== undefined) return false
  if (e.op === 'defer' && e.until !== undefined && !(e.until && UNTIL_KINDS.includes(e.until.kind))) return false
  if (!e.by || typeof e.by.device !== 'string' || !BOARD_ROLES.includes(e.by.role)) return false
  return Number.isFinite(e.seq) && typeof e.when === 'string'
}

function validEventNote(e: any): boolean {
  if (e.v !== 1 || !NOTE_KINDS.includes(e.kind) || typeof e.event !== 'string' || typeof e.match !== 'string' || typeof e.text !== 'string') return false
  if (!e.by || typeof e.by.device !== 'string' || !BOARD_ROLES.includes(e.by.role)) return false
  return Number.isFinite(e.seq) && typeof e.when === 'string'
}

/** Oldest first: by time, then device, then seq (old lines have device '' and seq 0). Ties otherwise keep file order. */
export function compareEvents(x: HistoryEvent, y: HistoryEvent): number {
  const stamped = (e: HistoryEvent) => (e.type === 'board' || e.type === 'event-note')
  const dx = stamped(x) ? (x as BoardEvent | EventNote).by.device : ''
  const dy = stamped(y) ? (y as BoardEvent | EventNote).by.device : ''
  const sx = stamped(x) ? (x as BoardEvent | EventNote).seq : 0
  const sy = stamped(y) ? (y as BoardEvent | EventNote).seq : 0
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
      else if (isObject && e.type === 'pit-check' && typeof e.sha === 'string' && ['GO', 'GO WITH DEFERRALS', 'NO-GO', 'NOT CHECKED'].includes(e.verdict)) events.push({ dirty: false, robot: '', when: '', ...e })
      else if (isObject && e.type === 'board' && validBoard(e)) events.push(e)
      else if (isObject && e.type === 'event-note' && validEventNote(e)) events.push(e)
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

/** The code of the latest pit check that came out GO or GO WITH DEFERRALS (null if none is on record). */
export function lastPassingSha(events: HistoryEvent[]): string | null {
  const go = events.filter((e): e is PitCheckEvent => e.type === 'pit-check' && (e.verdict === 'GO' || e.verdict === 'GO WITH DEFERRALS') && e.sha !== '')
  return go.sort(compareEvents).at(-1)?.sha ?? null
}

export interface BoardState {
  key: string
  robot: string
  priority?: string
  status?: string
  /** The latest deferral; absent when none was set or the last defer line cleared it. */
  deferred?: { until?: BoardUntil; by: BoardEvent['by']; when: string; match?: string; event?: string; played?: string }
  workaround?: string
  /** The owning role (software, pit or drive); absent when none was set or the last owner line cleared it. */
  owner?: string
  /** Every note, oldest first. */
  notes: { text: string; by: BoardEvent['by']; when: string; match?: string }[]
  /** Queue-sheet ticks (op 'checked'), oldest first: the match each was checked for. A tick is not a change to the issue (`by`, `when` and `match` below ignore it). */
  checked?: { match: string; by: BoardEvent['by']; when: string; event?: string; played?: string }[]
  /** Who made the latest change, and when, and on which match (absent when the line named none). */
  by: BoardEvent['by']
  when: string
  match?: string
  /** True once a line other than a tick has changed the issue (a state made only of ticks has no "last change"). */
  changed?: true
}

export const boardKey = (key: string, robot: string) => `${key}\u0000${robot}`

/** Replay the board lines oldest first: the latest priority, status, deferral and workaround per (issue, robot), all notes. */
export function boardState(events: HistoryEvent[]): Map<string, BoardState> {
  const out = new Map<string, BoardState>()
  for (const e of [...events].sort(compareEvents)) {
    if (e.type !== 'board') continue
    const k = boardKey(e.key, e.robot)
    const s = out.get(k) ?? { key: e.key, robot: e.robot, notes: [], by: e.by, when: e.when }
    if (e.op === 'checked') {
      ;(s.checked ??= []).push({ match: e.value, by: e.by, when: e.when, ...(e.event ? { event: e.event } : {}), ...(e.played ? { played: e.played } : {}) })
      out.set(k, s)
      continue
    }
    if (e.op === 'unchecked') {
      // Takes back the ticks for that match made in the same event (or with no event named).
      if (s.checked) s.checked = s.checked.filter((c) => !(c.match === e.value && (c.event ?? '') === (e.event ?? '')))
      if (s.checked?.length === 0) delete s.checked
      out.set(k, s)
      continue
    }
    if (e.op === 'priority') s.priority = e.value
    else if (e.op === 'status') s.status = e.value
    else if (e.op === 'defer') {
      if (e.value === '') delete s.deferred
      else s.deferred = { ...(e.until ? { until: e.until } : {}), by: e.by, when: e.when, ...(e.match ? { match: e.match } : {}), ...(e.event ? { event: e.event } : {}), ...(e.played ? { played: e.played } : {}) }
    } else if (e.op === 'workaround') s.workaround = e.value
    else if (e.op === 'owner') { if (e.value === '') delete s.owner; else s.owner = e.value }
    else s.notes.push({ text: e.value, by: e.by, when: e.when, ...(e.match ? { match: e.match } : {}) })
    s.by = e.by
    s.when = e.when
    s.changed = true
    if (e.match) s.match = e.match
    else delete s.match
    out.set(k, s)
  }
  return out
}

export interface EventNotes {
  /** The latest pit-change line per match, by `eventNoteKey(event, match)`: a later line replaces an earlier one, and an empty text clears it. */
  pitChange: Map<string, EventNote>
  /** Every "missed by Hindsight" line, oldest first. */
  missed: EventNote[]
  /** Every handoff read, oldest first. */
  handoffReads: EventNote[]
}

export const eventNoteKey = (event: string, match: string) => `${event}\u0000${match}`

/** Replay the event-note lines oldest first (the same order as boardState). */
export function eventNotes(events: HistoryEvent[]): EventNotes {
  const out: EventNotes = { pitChange: new Map(), missed: [], handoffReads: [] }
  for (const e of [...events].sort(compareEvents)) {
    if (e.type !== 'event-note') continue
    if (e.kind === 'pit-change') {
      if (e.text === '') out.pitChange.delete(eventNoteKey(e.event, e.match))
      else out.pitChange.set(eventNoteKey(e.event, e.match), e)
    } else if (e.kind === 'missed') out.missed.push(e)
    else out.handoffReads.push(e)
  }
  return out
}

/**
 * What a new board line carries: `seq` is 1 + this device's largest seq in the whole merged history (every machine's
 * file, so a reinstall with the same id can't repeat one), and `when` is the later of now and the newest `when` already
 * there, so a laptop whose clock runs behind still sorts its line after the lines it has seen.
 */
export function boardStamp(history: HistoryEvent[], device: string, now: Date = new Date()): { seq: number; when: string } {
  let seq = 0
  let when = now.toISOString()
  for (const e of history) {
    if ((e.type === 'board' || e.type === 'event-note') && e.by.device === device && e.seq > seq) seq = e.seq
    if (e.when > when) when = e.when
  }
  return { seq: seq + 1, when }
}

/**
 * The lines of a browser store's history the library's history lacks (compared by exact text), as one text to append,
 * or null when it holds nothing new. Run on every open: once the lines are in the library, the next open finds none.
 */
export function migrationLines(library: string, stored: string): { text: string; count: number } | null {
  // The library's text has been through parseHistory (which fills defaults, so key order can differ): compare in that form.
  const norm = (line: string) => serializeHistory(parseHistory(line).events).trimEnd() || line
  const have = new Set(library.split('\n').filter((l) => l.trim() !== '').map(norm))
  const fresh: string[] = []
  for (const line of stored.split('\n')) {
    if (line.trim() === '' || have.has(norm(line))) continue
    have.add(norm(line))
    fresh.push(line)
  }
  return fresh.length ? { text: `${fresh.join('\n')}\n`, count: fresh.length } : null
}
