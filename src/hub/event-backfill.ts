/**
 * Every event in a laptop's library published for the phone once, not only the latest. The laptop's own event files are
 * the record of what it has published: an event whose logs are all in them is skipped without reading a byte. An event
 * with logs not yet published is read one log at a time, grouped as the Session view groups (its days' pit runs count),
 * placed with The Blue Alliance, and only the lines not yet published are appended. A rules update alone republishes
 * nothing: the phone shows a summary from an older Hindsight, marked so (only a new summary shape, which the phone
 * can't draw, makes a log unpublished again). Out of sight of the Session view. No `node:` imports.
 */
import type { Entry } from './catalog.ts'
import type { EventLine } from './event-file.ts'
import { eventLines, eventLogNames } from './event-publish.ts'
import { groupSessions, type Session } from '../session/session.ts'
import type { MatchSummary } from '../session/summary.ts'
import { dateText } from '../session/day.ts'

const GAP = 4 * 86400e3
const at = (e: Entry) => e.record.playedAt!

/**
 * The library's events, newest first: on-field logs grouped (a gap of more than 4 days, or another FMS event name, starts a
 * new one), each with every log played on its days (the pit runs).
 */
export function eventClusters(entries: readonly Entry[]): Entry[][] {
  const dated = entries.filter((e) => e.local && !e.record.stub && e.record.playedAt !== null).sort((a, b) => at(a) - at(b))
  const groups: Entry[][] = []
  for (const e of dated.filter((x) => x.record.onField)) {
    const last = groups.at(-1)?.at(-1)
    const other = last && last.record.event && e.record.event && last.record.event !== e.record.event
    if (!last || at(e) - at(last) > GAP || other) groups.push([e]); else groups.at(-1)!.push(e)
  }
  return groups.map((field) => {
    const days = new Set(field.map((e) => dateText(at(e))))
    return dated.filter((e) => days.has(dateText(at(e))))
  }).reverse()
}

export interface BackfillDeps {
  entries: readonly Entry[]
  /** sha-256 of every log this laptop has published at the summary shape the phone draws (LocalLibrary.publishedShas). */
  published: ReadonlySet<string>
  /** sha-256 of logs read before and found to belong to no event The Blue Alliance places: not read again. */
  skipped?: ReadonlySet<string>
  /** Records logs read and found to belong to no placeable event (a failure to ask records nothing). */
  markSkipped?(shas: string[]): Promise<void>
  /** One log read into a summary (the Session view's summarizer), or null. */
  read(entry: Entry): Promise<MatchSummary | null>
  /** The Blue Alliance's key for an event session, or null when it can't be placed (then it is not published). */
  place(session: Session): Promise<string | null>
  append(key: string, lines: EventLine[]): Promise<void>
  version: string
  analyzerHash: string
  now(): number
  /** Asked before each log: true stops (the laptop is closing, a sign-out). */
  shouldStop?(): boolean
}

export async function backfillEvents(d: BackfillDeps): Promise<{ events: number; read: number }> {
  let events = 0
  let read = 0
  for (const cluster of eventClusters(d.entries)) {
    const done = (sha: string) => d.published.has(sha) || !!d.skipped?.has(sha)
    if (cluster.every((e) => done(e.record.sha256))) continue
    const summaries: MatchSummary[] = []
    const shaByName = new Map<string, string>()
    for (const e of cluster) {
      if (d.shouldStop?.()) return { events, read }
      const s = await d.read(e)
      read++
      if (s) { summaries.push(s); shaByName.set(s.fileName, e.record.sha256) }
    }
    const appended = new Set<string>()
    for (const s of groupSessions(summaries).filter((x) => x.kind === 'event' && x.matches.length > 0)) {
      const key = await d.place(s)
      if (!key) continue
      const shaOf = (name: string) => { const sha = shaByName.get(name); return sha && !d.published.has(sha) ? sha : null }
      const lines = eventLines({ summaries, names: eventLogNames(s), shaOf, version: d.version, analyzerHash: d.analyzerHash, at: d.now() })
      if (lines.length) { await d.append(key, lines); events++; for (const l of lines) appended.add(l.sha256) }
    }
    // Read, and not in any event that could be placed: remembered, so the next run doesn't read them again.
    const left = cluster.map((e) => e.record.sha256).filter((sha) => !done(sha) && !appended.has(sha))
    if (left.length) await d.markSkipped?.(left)
  }
  return { events, read }
}
