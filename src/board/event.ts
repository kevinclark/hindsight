/**
 * Which Blue Alliance event a session is, so the board can read the team's schedule (ADR 6). A session of logs with no event
 * name already has one (src/tba/identify.ts found it). A session whose logs name their event (the FMS wrote a name) has no
 * TBA key; it is found the same way, by the team's qualification numbers: the logs are offered to `identifyEvents` as if they
 * named no event, so the same test (the event whose list for the team holds their numbers) decides.
 */
import type { Session } from '../session/session.ts'
import { identifyEvents, REFUSED_WORDS, type ClusterResult, type ResolvedEvent } from '../tba/identify.ts'
import type { TbaGet } from '../tba/source.ts'

export interface SessionEvent { event: ResolvedEvent | null; why: string | null }

const WHY: Record<NonNullable<ClusterResult['why']>, string> = {
  'no quals': 'these logs name no qualification match numbers to look up',
  'no event': "no event on the team's list holds these qualification numbers",
  tie: "two events on the team's list hold these qualification numbers equally",
  unreachable: 'The Blue Alliance could not be reached and no saved copy covers this',
  refused: REFUSED_WORDS,
}

export async function sessionEvent(session: Pick<Session, 'event' | 'matches'>, team: number, get: TbaGet): Promise<SessionEvent> {
  if (session.event) return { event: session.event, why: null }
  const logs = session.matches.map((m) => ({ fileName: m.fileName, playedAt: m.playedAt, onField: m.onField, event: '', matchLabel: m.matchLabel }))
  const found = await identifyEvents(logs, team, get)
  const event = [...found.byFile.values()][0] ?? null
  if (event) return { event, why: null }
  const why = found.clusters.map((c) => c.why).find((w) => w !== null) ?? 'no'
  return { event: null, why: why === 'no' ? 'no on-field qualification logs to look up' : WHY[why] }
}
