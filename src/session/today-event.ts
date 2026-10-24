/**
 * Is today an event day when the Session view holds no logs of it (the desktop app, opened at the pit before any log is
 * loaded)? Two signals, neither needing the Session view: The Blue Alliance's team events for the year put today inside an
 * event's dates, or the library holds an on-field log dated today. The single-file page has neither and keeps the old
 * behaviour. Pure: the lists come in; the caller fetches them.
 */
import { dateText } from './day.ts'
import type { TbaEventSimple } from '../tba/api.ts'
import { eventLabel } from '../tba/identify.ts'

export interface TodayEvent {
  /** The id a hand choice is kept under: the event's key for its dates, or the day for a library log. */
  id: string
  name: string
  /** The Blue Alliance's event key, for the schedule signal. */
  key?: string
  signal: 'tba' | 'library'
}

/** The words the mode line adds, so it says which signal decided. */
export const SIGNAL_WORDS: Record<TodayEvent['signal'], string> = {
  tba: "from The Blue Alliance's schedule",
  library: "from a log in the library dated today",
}

/** The team's event whose dates (the event's own calendar days, inclusive) hold the laptop's today. */
export function eventFromSchedule(events: readonly Pick<TbaEventSimple, 'key' | 'name' | 'start_date' | 'end_date'>[], now: number): TodayEvent | null {
  const today = dateText(now)
  const e = events.find((x) => x.start_date <= today && today <= x.end_date)
  return e ? { id: `event-days:${e.key}`, name: eventLabel(e.name, e.key), key: e.key, signal: 'tba' } : null
}

/** An on-field log in the library dated today (by the laptop's day). */
export function eventFromLibrary(logs: readonly { onField?: boolean; playedAt: number | null; event?: string }[], now: number): TodayEvent | null {
  const today = dateText(now)
  const log = logs.find((l) => l.onField && l.playedAt !== null && dateText(l.playedAt) === today)
  return log ? { id: `event-days:library:${today}`, name: log.event || 'an event', signal: 'library' } : null
}
