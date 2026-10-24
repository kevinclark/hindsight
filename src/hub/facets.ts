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

/** How one log is shown in the robot facet: `group` is the robot's name, `label` adds which physical robot when the name covers more than one. */
export interface RobotLabel { label: string; group: string; guess: boolean }
/** Each log's robot label, by sha-256. */
export type RobotLabels = Map<string, RobotLabel>

const byTime = (a: Entry, b: Entry) => (a.record.playedAt ?? Infinity) - (b.record.playedAt ?? Infinity)

/** The logs of one robot name that has more than one roboRIO, labelled by edition where the log or its roboRIO gives one, else by roboRIO. */
function splitGroup(name: string, logs: Entry[]): [Entry, RobotLabel][] {
  const count = new Map<string, number>()
  const editionsOf = new Map<string, Set<string>>()
  for (const { record: r } of logs) {
    if (!r.roboRio) continue
    count.set(r.roboRio, (count.get(r.roboRio) ?? 0) + 1)
    if (r.edition) editionsOf.set(r.roboRio, (editionsOf.get(r.roboRio) ?? new Set()).add(r.edition))
  }
  const anyEdition = logs.some((e) => e.record.edition)
  // The roboRIO with the most logs keeps the plain name; on a tie, the one whose first log came first.
  const first = new Map<string, number>()
  for (const e of [...logs].sort(byTime)) if (e.record.roboRio && !first.has(e.record.roboRio)) first.set(e.record.roboRio, first.size)
  const main = [...count].sort((a, b) => b[1] - a[1] || first.get(a[0])! - first.get(b[0])!)[0][0]
  return logs.map((e) => {
    const { roboRio, edition } = e.record
    const plain = { label: name, group: name, guess: false }
    if (anyEdition && edition) return [e, { ...plain, label: `${name} · ${edition}` }]
    const known = roboRio ? editionsOf.get(roboRio) : undefined
    if (anyEdition && known?.size === 1) return [e, { ...plain, label: `${name} · ${[...known][0]}`, guess: true }]
    // A log with no roboRIO in a split group would read as the plain name (no log in the library is like that today).
    if (!roboRio || roboRio === main) return [e, plain]
    return [e, { ...plain, label: `${name} · other roboRIO …${roboRio.slice(-4)}` }]
  })
}

/**
 * The robot facet's value for every log, decided over the whole library (not the filtered list), so a filter never
 * renames a robot. A name with one roboRIO (or none) stays plain. With two or more, the logs are told apart by the
 * robot's own edition, a log without one taking the edition its roboRIO has everywhere else (a guess), else by roboRIO.
 */
export function robotLabels(entries: Entry[]): RobotLabels {
  const out: RobotLabels = new Map()
  const groups = new Map<string, Entry[]>()
  for (const e of entries) {
    const typed = e.tags.robot
    if (typed || !e.record.robot) {
      const name = typed ?? UNKNOWN.robot
      out.set(e.record.sha256, { label: name, group: name, guess: false })
    } else groups.set(e.record.robot.name, [...(groups.get(e.record.robot.name) ?? []), e])
  }
  for (const [name, logs] of groups) {
    const split = new Set(logs.map((e) => e.record.roboRio).filter(Boolean)).size > 1
    for (const [e, label] of split ? splitGroup(name, logs) : logs.map((e) => [e, { label: name, group: name, guess: false }] as const)) out.set(e.record.sha256, label)
  }
  return out
}

/** The event The Blue Alliance named for on-field logs whose FMS event name is blank, by sha-256 (src/tba/identify.ts): "Name 2099". */
export type Places = ReadonlyMap<string, string>

/** The value of each facet for one log. */
export function facetValues(e: Entry, labels: RobotLabels, places?: Places): Record<FacetId, string> {
  const r = e.record
  return {
    schoolYear: r.playedAt === null ? UNKNOWN.schoolYear : schoolYear(r.playedAt),
    season: r.playedAt === null ? UNKNOWN.season : seasonOf(r.playedAt) === 'season' ? 'Season' : 'Off-season',
    // On the field the FMS names the event; anywhere else a person types where the practice was.
    place: fmsPlace(r)?.name ?? places?.get(r.sha256) ?? e.tags.place ?? UNKNOWN.place,
    matchType: r.matchType !== null ? MATCH_TYPES[r.matchType] ?? UNKNOWN.matchType : UNKNOWN.matchType,
    battery: e.tags.battery ?? r.batteryId ?? UNKNOWN.battery,
    robot: labels.get(r.sha256)?.label ?? UNKNOWN.robot,
    driver: e.tags.driver ?? UNKNOWN.driver,
  }
}

export type Selection = Partial<Record<FacetId, string[]>>

/** Entries that match every facet that has picks, where any pick of a facet matches. */
export function filterEntries(entries: Entry[], selection: Selection, labels: RobotLabels, places?: Places): Entry[] {
  return entries.filter((e) => {
    const values = facetValues(e, labels, places)
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
export function facetCounts(entries: Entry[], selection: Selection, labels: RobotLabels, places?: Places): Record<FacetId, [value: string, count: number][]> {
  const out = {} as Record<FacetId, [string, number][]>
  for (const f of FACETS) {
    const others = { ...selection, [f]: undefined }
    const counts = new Map<string, number>()
    for (const e of filterEntries(entries, others, labels, places)) {
      const v = facetValues(e, labels, places)[f]
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    // Picked values stay listed even at zero, so they can be unpicked.
    for (const v of selection[f] ?? []) if (!counts.has(v)) counts.set(v, 0)
    const order = f === 'robot' ? robotOrder(counts, labels) : (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0])
    out[f] = [...counts].sort(f === 'schoolYear' ? (a, b) => b[0].localeCompare(a[0]) : order)
  }
  return out
}

/** The robot facet's order: robots by their counted logs (biggest first), and within one robot its plain name first, then by count. */
function robotOrder(counts: Map<string, number>, labels: RobotLabels): (a: [string, number], b: [string, number]) => number {
  const group = new Map<string, string>()
  for (const l of labels.values()) group.set(l.label, l.group)
  const of = (v: string) => group.get(v) ?? v
  const total = new Map<string, number>()
  for (const [v, n] of counts) total.set(of(v), (total.get(of(v)) ?? 0) + n)
  return (a, b) => {
    const [ga, gb] = [of(a[0]), of(b[0])]
    if (ga !== gb) return total.get(gb)! - total.get(ga)! || ga.localeCompare(gb)
    return Number(b[0] === gb) - Number(a[0] === ga) || b[1] - a[1] || a[0].localeCompare(b[0])
  }
}
