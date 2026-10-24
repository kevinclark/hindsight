/**
 * Event days (ADR 3): the mode is decided per local day, so a log that was not on the field, played on a day an event had
 * on-field logs, is a pit run of that event. One place for the rule, used by session grouping and the Library's place
 * facet so the two always agree. The day is the local day in the event's time zone, else the laptop's.
 */
import { dayIn } from './identify.ts'

/** The days (YYYY-MM-DD) an event had on-field logs, in its own time zone. */
export interface EventDays { timezone: string | null; days: Set<string> }
export type EventDayIndex<K> = Map<K, EventDays>

/** Note that event `key` had an on-field log at `playedAt`. */
export function addEventDay<K>(index: EventDayIndex<K>, key: K, playedAt: number, timezone: string | null): void {
  const e = index.get(key) ?? { timezone, days: new Set<string>() }
  e.days.add(dayIn(playedAt, e.timezone))
  index.set(key, e)
}

/** The event (in insertion order, the first) that had matches on the local day of `playedAt`, or undefined. */
export function eventOfDay<K>(index: EventDayIndex<K>, playedAt: number): K | undefined {
  for (const [key, e] of index) if (e.days.has(dayIn(playedAt, e.timezone))) return key
  return undefined
}
