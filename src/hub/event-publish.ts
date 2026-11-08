/**
 * What a laptop publishes for the phone, worked out in the page (where summaries are made, the kept robot profiles live and
 * the event lookup runs): the latest event session as the Session view groups it (so a log placed by The Blue Alliance's
 * quals, or a pit run on one of the event's days, counts exactly as the board counts it), one line per log, keyed by the
 * library's sha-256. The main process appends the lines and pushes the file (`hub.appendEvent`). No `node:` imports.
 */
import type { Session } from '../session/session.ts'
import { SUMMARY_SHAPE, type MatchSummary } from '../session/summary.ts'
import { analyzerId, withoutMarks, type EventLine } from './event-file.ts'

declare const __ANALYZER_HASH__: string
/** The analyzer's source hash, from the build (vite.config.ts); 'dev' where nothing defines it (tests, plain node). */
export const ANALYZER_HASH = typeof __ANALYZER_HASH__ === 'string' ? __ANALYZER_HASH__ : 'dev'

const lastPlayed = (s: Session) => Math.max(...s.matches.map((m) => m.playedAt ?? -Infinity))

/** The event session played most recently: the current event, or the last one (only these are written; no backfill). */
export function latestEventSession(sessions: readonly Session[]): Session | null {
  return sessions.filter((s) => s.kind === 'event' && s.matches.length > 0).reduce<Session | null>((best, s) => (best === null || lastPlayed(s) > lastPlayed(best) ? s : best), null)
}

/** Every log file of an event session: each match's pieces (a match recorded in several logs) and the pit runs. */
export function eventLogNames(session: Session): string[] {
  return [...session.matches, ...(session.pitRuns ?? [])].flatMap((m) => m.pieces ?? [m.fileName])
}

export interface EventLinesInput {
  /** The logs' own summaries (the Session view's, one per log file, never a joined match). */
  summaries: readonly MatchSummary[]
  /** The event's log files (eventLogNames). */
  names: readonly string[]
  /** The library's sha-256 for a log file, or null when the library does not hold it. */
  shaOf(fileName: string): string | null
  version: string
  /** The analyzer's source hash (`__ANALYZER_HASH__`). */
  analyzerHash: string
  at: number
}

/** A line per event log the library holds, without the team's marks. */
export function eventLines(input: EventLinesInput): EventLine[] {
  const wanted = new Set(input.names)
  const out: EventLine[] = []
  for (const s of input.summaries) {
    if (!wanted.has(s.fileName)) continue
    const sha256 = input.shaOf(s.fileName)
    if (!sha256) continue
    out.push({ sha256, analyzer: analyzerId(input.version, input.analyzerHash, s.robot.profileId, !!s.codeFolder, s.powerMap?.stamp), shape: SUMMARY_SHAPE, at: input.at, summary: withoutMarks(s) })
  }
  return out
}
