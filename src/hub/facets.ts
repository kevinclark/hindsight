/**
 * The facets the Library view filters by. Within a facet, picks are OR; across facets, AND. Every facet value is text,
 * so the view treats them alike. A log with no value for a facet has the facet's "unknown" word, which can be picked too.
 */
import type { Entry } from './catalog.ts'
import { schoolYear } from './layout.ts'
import { seasonOf } from './season.ts'
import { resolveEvent } from './events.ts'
import type { LogMeta } from './types.ts'

export const FACETS = ['schoolYear', 'season', 'place', 'matchType', 'battery', 'robot', 'driver'] as const
export type FacetId = (typeof FACETS)[number]

export const FACET_LABELS: Record<FacetId, string> = {
  schoolYear: 'School year', season: 'Season', place: 'Event or practice place', matchType: 'Match type', battery: 'Battery', robot: 'Robot', driver: 'Driver',
}

export const UNKNOWN: Record<FacetId, string> = {
  schoolYear: 'No date', season: 'No date', place: 'No place', matchType: 'Not a match', battery: 'No battery', robot: 'Unknown robot', driver: 'No driver',
}

const MATCH_TYPES = ['Not a match', 'Practice match', 'Qualification', 'Elimination']

/** The event name the FMS gave a log, as people say it: the table's name for the code when it has one, else the FMS text. Null when the log is not on the field or names nothing. */
export function fmsPlace(r: Pick<LogMeta, 'onField' | 'event' | 'playedAt'>): { name: string; resolved: boolean } | null {
  if (!r.onField || !r.event) return null
  const name = resolveEvent(r.event, r.playedAt)
  return name ? { name, resolved: true } : { name: r.event, resolved: false }
}

/** A robot the log only names by its own Codebase text, or a profile that was a best guess: shown with a plain marker. */
export function robotIsGuess(r: Pick<LogMeta, 'robot'>): boolean {
  return !!r.robot && (r.robot.profileId === null || r.robot.how === 'signals')
}

/** The value of each facet for one log. */
export function facetValues(e: Entry): Record<FacetId, string> {
  const r = e.record
  const hardware = e.attached.hoot.map((h) => h.hardwareId).find((id) => id && id !== 'rio')
  const robotName = e.tags.robot ?? (r.robot ? (hardware ? `${r.robot.name} · CANivore ${hardware}` : r.robot.name) : UNKNOWN.robot)
  return {
    schoolYear: r.playedAt === null ? UNKNOWN.schoolYear : schoolYear(r.playedAt),
    season: r.playedAt === null ? UNKNOWN.season : seasonOf(r.playedAt) === 'season' ? 'Season' : 'Off-season',
    // On the field the FMS names the event; anywhere else a person types where the practice was.
    place: fmsPlace(r)?.name ?? e.tags.place ?? UNKNOWN.place,
    matchType: r.matchType !== null ? MATCH_TYPES[r.matchType] ?? UNKNOWN.matchType : UNKNOWN.matchType,
    battery: e.tags.battery ?? r.batteryId ?? UNKNOWN.battery,
    robot: robotName,
    driver: e.tags.driver ?? UNKNOWN.driver,
  }
}

export type Selection = Partial<Record<FacetId, string[]>>

/** Entries that match every facet that has picks, where any pick of a facet matches. */
export function filterEntries(entries: Entry[], selection: Selection): Entry[] {
  return entries.filter((e) => {
    const values = facetValues(e)
    return FACETS.every((f) => !selection[f]?.length || selection[f]!.includes(values[f]))
  })
}

/**
 * A value's count as the filter column shows it. In a facet that already has a pick, an unpicked value would join the
 * list (picks within a facet are OR), so its count is what it adds: "+12". Anywhere else it is what the list would hold.
 */
export function countLabel(selection: Selection, f: FacetId, value: string, n: number): string {
  const picks = selection[f] ?? []
  return picks.length && !picks.includes(value) ? `+${n}` : `${n}`
}

/**
 * Each facet's values with how many logs have them. A facet's counts ignore its own picks (so picking a second school year
 * shows what it would add) but respect every other facet's.
 */
export function facetCounts(entries: Entry[], selection: Selection): Record<FacetId, [value: string, count: number][]> {
  const out = {} as Record<FacetId, [string, number][]>
  for (const f of FACETS) {
    const others = { ...selection, [f]: undefined }
    const counts = new Map<string, number>()
    for (const e of filterEntries(entries, others)) {
      const v = facetValues(e)[f]
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    // Picked values stay listed even at zero, so they can be unpicked.
    for (const v of selection[f] ?? []) if (!counts.has(v)) counts.set(v, 0)
    out[f] = [...counts].sort((a, b) => (f === 'schoolYear' ? b[0].localeCompare(a[0]) : b[1] - a[1] || a[0].localeCompare(b[0])))
  }
  return out
}
