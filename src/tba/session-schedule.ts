/**
 * The team's schedule at a session's event, and the line that says where it came from (or why there is none). One read for
 * the Session view's board and Foresight's queue, so both place the same due points and the same cut-off. Never throws: with
 * no event found, or any error (offline with no saved copy, a refused key), it answers `schedule: null` and says why.
 * With a Nexus reader, each match also carries Nexus's live queue and start times (ADR 12); a Nexus failure only adds a
 * clause to the note and leaves The Blue Alliance's times.
 */
import type { Session } from '../session/session.ts'
import { sessionEvent } from '../board/event.ts'
import { teamSchedule, type ScheduledMatch } from './schedule.ts'
import type { TbaGet } from './source.ts'
import type { NexusGet } from '../nexus/source.ts'
import { nexusTimes, withNexus } from '../nexus/times.ts'

export interface SessionSchedule {
  schedule: ScheduledMatch[] | null
  note: string | null
  /** The event key Nexus answered for, when its times are on the schedule (for the credit link Nexus asks for). */
  nexusEvent?: string | null
}

const clockOf = (ms: number) => new Date(ms).toLocaleTimeString()

export async function sessionSchedule(session: Pick<Session, 'event' | 'matches'>, team: number, get: TbaGet, nexus?: NexusGet | null): Promise<SessionSchedule> {
  try {
    const found = await sessionEvent(session, team, get)
    if (!found.event) return { schedule: null, note: `No schedule: ${found.why}.` }
    const got = await teamSchedule(get, team, found.event.key, found.event.end)
    const note = `Schedule for ${found.event.key}${got.fromCache ? ' from a saved copy' : ''} as of ${clockOf(got.fetchedAt)}; times are estimates.`
    if (!nexus) return { schedule: got.data, note, nexusEvent: null }
    try {
      const live = await nexus(found.event.key)
      const times = nexusTimes(live.data)
      if (times.size === 0) return { schedule: got.data, note: `${note} Nexus has no matches for this event yet.`, nexusEvent: null }
      return { schedule: withNexus(got.data, times), note: `${note} Queue and start times from Nexus${live.fromCache ? ', a saved copy' : ''} as of ${clockOf(live.fetchedAt)}.`, nexusEvent: found.event.key }
    } catch (e) {
      return { schedule: got.data, note: `${note} No Nexus times: ${e instanceof Error ? e.message : String(e)}`, nexusEvent: null }
    }
  } catch (e) {
    return { schedule: null, note: `No schedule: ${e instanceof Error ? e.message : String(e)}` }
  }
}
