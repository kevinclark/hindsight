/**
 * The mode a session is in (ADR 3): an event (matches on a field, and the pit runs between them) or practice (every log
 * is a run, ADR 8). Slice 5 infers it per local day; this file words it for the one persistent line every view shows, and
 * applies the student's choice for one session. Pure: no page, no storage.
 *
 * The student's choice is kept per session id in the same store as session renames (`hindsight.sessionRenames`), under
 * the key `mode:<session id>`: a rename is looked up by the bare id, so the two never meet.
 */
import type { MatchSummary } from './summary.ts'
import { eventLabel } from '../tba/identify.ts'
import { dateText } from './day.ts'
import type { Session } from './session.ts'

export type Mode = 'event' | 'practice'

/** Key prefix of a mode choice in the renames store. */
export const MODE_PREFIX = 'mode:'

/** The mode the student chose for this session, or null (automatic). */
export function modeChoice(store: Readonly<Record<string, string>>, sessionId: string): Mode | null {
  const v = store[MODE_PREFIX + sessionId]
  return v === 'event' || v === 'practice' ? v : null
}

/** The store with the choice set (`null`: back to automatic). Returns a new object. */
export function withModeChoice(store: Record<string, string>, sessionId: string, mode: Mode | null): Record<string, string> {
  const { [MODE_PREFIX + sessionId]: _old, ...rest } = store
  return mode === null ? rest : { ...rest, [MODE_PREFIX + sessionId]: mode }
}

const STAGES: [number, string][] = [[1, 'practice'], [2, 'qualification'], [3, 'elimination']]

/** "qualification", "qualification and elimination": the match types the field data of these logs carry. */
export function stageWords(logs: MatchSummary[]): string {
  const types = new Set(logs.filter((m) => m.onField).map((m) => m.matchType))
  const words = STAGES.filter(([n]) => types.has(n)).map(([, w]) => w)
  return words.length ? words.join(' and ') : 'on the field'
}

/** The first dated log's day, "2025-07-12", or null. */
function firstDay(logs: MatchSummary[]): string | null {
  const at = logs.find((m) => m.playedAt !== null)?.playedAt
  return at === undefined || at === null ? null : dateText(at)
}

/** The event's name as the field data or The Blue Alliance gives it. */
function eventName(session: Session): string {
  if (session.event) return eventLabel(session.event.name, session.event.key) + (session.event.by === 'date' ? ' (guess)' : '')
  const named = session.matches.find((m) => m.onField && m.event)?.event
  if (named) return named
  const day = firstDay(session.matches)
  return day ? `starting ${day}, no event name logged` : 'no event name logged'
}

/** The line, whole, for a session: "Event · Name · qualification (from the field data)", "Practice · 2025-07-12". */
export function modeLine(session: Pick<Session, 'kind' | 'mode' | 'modeByHand' | 'matches' | 'pitRuns' | 'event' | 'label'>): string {
  const hand = session.modeByHand ? ' (set by hand)' : ''
  if (modeOf(session) === 'event') {
    if (session.kind !== 'event') return `Event · ${session.label}${hand}`
    const fromField = session.matches.some((m) => m.onField)
    return `Event · ${eventName(session as Session)}${fromField ? ` · ${stageWords(session.matches)}` : ''}${session.modeByHand ? hand : ' (from the field data)'}`
  }
  const day = firstDay([...session.matches, ...(session.pitRuns ?? [])])
  return `Practice · ${day ?? 'no date'}${hand}`
}

/** The session's mode (a session built by hand in a test has none set: its kind says). */
export const modeOf = (s: Pick<Session, 'kind' | 'mode'>): Mode => s.mode ?? inferredMode(s.kind)

/** The line for one log inside its session: a pit run says so, any other log gets its session's line. */
export function logModeLine(session: Session, fileName: string): string {
  const pit = modeOf(session) === 'event' && (session.pitRuns ?? []).some((m) => m.fileName === fileName || m.pieces?.includes(fileName))
  return pit ? `Event · pit run on an event day${session.modeByHand ? ' (set by hand)' : ''}` : modeLine(session)
}

/**
 * The line for a log nothing has grouped (opened alone, or before a session is loaded), the mode it is in, and the session
 * id the student's choice is kept under. An on-field log is an event; a log off the field is practice (a pit run needs the
 * day's other logs to know it belongs to an event). `choice` is what the store holds under that id.
 */
export function loneLogMode(m: { onField: boolean; event: string; matchLabel: string; playedAt: number | null }, store: Readonly<Record<string, string>> = {}): { line: string; sessionId: string; mode: Mode; byHand: boolean } {
  const day = m.playedAt === null ? null : dateText(m.playedAt)
  const sessionId = m.onField ? `event:${m.event}:${day ?? ''}` : day ? `practice:${day}` : 'undated'
  const choice = modeChoice(store, sessionId)
  const mode = choice ?? (m.onField ? 'event' : 'practice')
  const how = choice ? 'set by hand; this log alone' : m.onField ? 'from the field data; this log alone' : 'this log alone'
  const line = mode === 'event'
    ? `Event · ${m.event ? `${m.event} · ` : ''}${m.matchLabel || (m.onField ? 'on the field' : 'this log')} (${how})`
    : `Practice · ${day ?? 'no date'} (${how})`
  return { line, sessionId, mode, byHand: choice !== null }
}

/**
 * Foresight's line: the robot sitting disabled in the pit is a pit run when today (the laptop's day) is an event day of a
 * session the Session view holds, else practice. With no session loaded it can only say practice. The choice is kept under
 * that session's id, or the id a practice session for today would have.
 */
export function todayMode(sessions: readonly Session[], now: number, store: Readonly<Record<string, string>> = {}): { line: string; sessionId: string; mode: Mode; byHand: boolean } {
  const today = dateText(now)
  const event = sessions.find((s) => s.kind === 'event' && s.matches.some((m) => m.onField && m.playedAt !== null && dateText(m.playedAt) === today))
  const sessionId = event ? event.id : `practice:${today}`
  const choice = modeChoice(store, sessionId)
  const mode = choice ?? (event ? 'event' : 'practice')
  const how = choice ? ' (set by hand)' : ''
  const line = mode === 'event'
    ? (event && !choice ? 'Event · pit run on an event day' : `Event · ${event ? eventName(event) : 'today'}${how}`)
    : `Practice · ${today}${how}`
  return { line, sessionId, mode, byHand: choice !== null }
}

/** The mode a kind of session starts in. */
export const inferredMode = (kind: Session['kind']): Mode => (kind === 'event' ? 'event' : 'practice')

/**
 * Put the student's choice into effect on a freshly grouped session. Practice treats every log as a run (pit runs join the
 * session's logs); event treats on-field logs as matches and every other log as a pit run.
 */
export function applyMode(session: Session, choice: Mode | null): void {
  const inferred = inferredMode(session.kind)
  session.mode = choice ?? inferred
  session.modeByHand = choice !== null
  const byTime = (a: MatchSummary, b: MatchSummary) => (a.playedAt ?? Infinity) - (b.playedAt ?? Infinity) || a.fileName.localeCompare(b.fileName)
  if (session.mode === 'practice' && session.pitRuns?.length) {
    session.matches = [...session.matches, ...session.pitRuns].sort(byTime)
    delete session.pitRuns
  } else if (session.mode === 'event' && inferred === 'practice') {
    const pit = session.matches.filter((m) => !m.onField)
    if (pit.length) { session.matches = session.matches.filter((m) => m.onField); session.pitRuns = pit }
  }
}
