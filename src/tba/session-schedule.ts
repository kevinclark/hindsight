/**
 * The team's schedule at a session's event, and the line that says where it came from (or why there is none). One read for
 * the Session view's board and Foresight's queue, so both place the same due points and the same cut-off. Never throws: with
 * no event found, or any error (offline with no saved copy, a refused key), it answers `schedule: null` and says why.
 */
import type { Session } from '../session/session.ts'
import { sessionEvent } from '../board/event.ts'
import { teamSchedule, type ScheduledMatch } from './schedule.ts'
import type { TbaGet } from './source.ts'

export interface SessionSchedule { schedule: ScheduledMatch[] | null; note: string | null }

export async function sessionSchedule(session: Pick<Session, 'event' | 'matches'>, team: number, get: TbaGet): Promise<SessionSchedule> {
  try {
    const found = await sessionEvent(session, team, get)
    if (!found.event) return { schedule: null, note: `No schedule: ${found.why}.` }
    const got = await teamSchedule(get, team, found.event.key, found.event.end)
    return { schedule: got.data, note: `Schedule for ${found.event.key}${got.fromCache ? ' from a saved copy' : ''} as of ${new Date(got.fetchedAt).toLocaleTimeString()}; times are estimates.` }
  } catch (e) {
    return { schedule: null, note: `No schedule: ${e instanceof Error ? e.message : String(e)}` }
  }
}
