/**
 * The place facet's help from event days: which event The Blue Alliance named for on-field logs with a blank FMS name, and
 * which event each pit run (a log not on the field, on a day an event had matches) belongs to. The day rule is the Session
 * view's own (src/tba/event-days.ts), so the Library and the Session agree about pit runs. No `node:` imports.
 */
import type { Entry } from './catalog.ts'
import { fmsPlace, type Places } from './facets.ts'
import { addEventDay, eventOfDay, type EventDayIndex } from '../tba/event-days.ts'
import { eventLabel, type ResolvedEvent } from '../tba/identify.ts'

/** `identified`: the events TBA found, by the sha-256 of each blank-event on-field log. Returns a place for those logs and for every pit run on an event's days. */
export function eventPlaces(entries: readonly Entry[], identified: ReadonlyMap<string, ResolvedEvent>): Places {
  const out = new Map<string, string>()
  const days: EventDayIndex<string> = new Map()
  for (const e of entries) {
    const r = e.record
    if (!r.onField || r.playedAt === null) continue
    const found = identified.get(r.sha256)
    const name = fmsPlace(r)?.name ?? (found ? eventLabel(found.name, found.key) : null)
    if (!name) continue
    if (found && !fmsPlace(r)) out.set(r.sha256, name)
    addEventDay(days, name, r.playedAt, found?.timezone ?? null)
  }
  for (const e of entries) {
    const r = e.record
    if (r.onField || r.stub || r.playedAt === null) continue
    const name = eventOfDay(days, r.playedAt)
    if (name) out.set(r.sha256, name)
  }
  return out
}
