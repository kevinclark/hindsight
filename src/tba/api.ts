/** The TBA calls, typed to the fields Hindsight reads. */
import type { Fetched, TbaGet } from './source.ts'

export interface TbaEventSimple { key: string; name: string; event_code?: string; year?: number; start_date: string; end_date: string }
export interface TbaEvent extends TbaEventSimple { timezone?: string | null }
export interface TbaMatchSimple {
  key: string
  comp_level: string
  set_number?: number
  match_number: number
  /** Scheduled, predicted and actual start (seconds since 1970); null before TBA has them. */
  time?: number | null
  predicted_time?: number | null
  actual_time?: number | null
}

export const teamEvents = (get: TbaGet, team: number, year: number): Promise<Fetched<TbaEventSimple[]>> => get(`/team/frc${team}/events/${year}/simple`)
export const eventInfo = (get: TbaGet, eventKey: string): Promise<Fetched<TbaEvent>> => get(`/event/${eventKey}`)
/** `eventEnd`: the event's last day, so a finished event's list is kept (src/tba/source.ts ttlOf). */
export const teamMatches = (get: TbaGet, team: number, eventKey: string, eventEnd?: string): Promise<Fetched<TbaMatchSimple[]>> => get(`/team/frc${team}/event/${eventKey}/matches/simple`, { eventEnd })
/** A match from the full list: the same fields, and the videos TBA holds for it (`type` 'youtube' has the video id in `key`). */
export interface TbaMatchFull extends TbaMatchSimple { videos?: { type: string; key: string }[] }
/** The team's full match list, the form that carries `videos` (the simple one does not). */
export const teamMatchesFull = (get: TbaGet, team: number, eventKey: string, eventEnd?: string): Promise<Fetched<TbaMatchFull[]>> => get(`/team/frc${team}/event/${eventKey}/matches`, { eventEnd })
