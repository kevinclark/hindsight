/**
 * The team's schedule at one event, from The Blue Alliance's list of the team's matches, and the gaps between its
 * matches (ADR 6). A deferral point is named by match number ("after Q37: overnight"); the times only estimate how long
 * that gap will be, because the day's schedule drifts. Nothing here reads the clock or the network.
 */
import { teamMatches, type TbaMatchSimple } from './api.ts'
import type { Fetched, TbaGet } from './source.ts'

export type CompLevel = 'qm' | 'ef' | 'qf' | 'sf' | 'f'
const LEVELS = new Set<string>(['qm', 'ef', 'qf', 'sf', 'f'])

export interface ScheduledMatch {
  /** TBA's match key ("2099test_qm12"). */
  key: string
  level: CompLevel
  number: number
  /** Playoff set (1 for a qualification). */
  set: number
  /** Scheduled start, predicted start and actual start (ms since 1970); null while TBA has none. */
  scheduled: number | null
  predicted: number | null
  actual: number | null
}

const ms = (s: number | null | undefined): number | null => (typeof s === 'number' && Number.isFinite(s) ? s * 1000 : null)

/** The team's matches in play order (by time where TBA has one, else qualifications by number, then playoffs). Rows of a kind this does not know are dropped. */
export function parseSchedule(raw: readonly TbaMatchSimple[]): ScheduledMatch[] {
  const rank: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 }
  return raw
    .filter((m) => LEVELS.has(m.comp_level) && Number.isInteger(m.match_number))
    .map((m): ScheduledMatch => ({
      key: m.key, level: m.comp_level as CompLevel, number: m.match_number, set: m.set_number ?? 1,
      scheduled: ms(m.time), predicted: ms(m.predicted_time), actual: ms(m.actual_time),
    }))
    .sort((a, b) => rank[a.level] - rank[b.level] || a.set - b.set || a.number - b.number)
}

/** The team's schedule at an event, with when it was fetched (from the saved copy when offline). */
export async function teamSchedule(get: TbaGet, team: number, eventKey: string): Promise<Fetched<ScheduledMatch[]>> {
  const got = await teamMatches(get, team, eventKey)
  return { ...got, data: parseSchedule(got.data) }
}

/** When a match starts, as well as is known: it happened, else TBA's prediction, else the printed schedule. */
export const startOf = (m: ScheduledMatch): number | null => m.actual ?? m.predicted ?? m.scheduled

export type GapName = 'lunch' | 'overnight' | 'before playoffs'

export interface Gap {
  /** The team's qualification match this gap follows, and the team's next match (null after the last one with no later match known). */
  after: number
  next: { level: CompLevel; number: number } | null
  /** Estimated minutes from this match's start to the next one's, or null when either time is unknown. It includes the match itself (about 7 minutes). */
  minutes: number | null
  name: GapName | null
}

/** A gap this long between two matches can only be a night. Assumed, not measured. */
export const OVERNIGHT_MINUTES = 6 * 60
/** A day's lunch is its longest gap, if that gap is at least this long and this many times the day's typical gap, with at least three gaps in the day to judge by. Assumed, not measured. */
export const LUNCH_MINUTES = 90
export const LUNCH_TIMES_TYPICAL = 1.25
export const LUNCH_MIN_GAPS = 3

/**
 * The gaps after the team's qualification matches numbered `after` or later, in match order. A gap is named by its size
 * and where it falls (by match, not by clock time):
 *  - overnight: a gap of 6 hours or more between two qualifications;
 *  - before playoffs: the gap after the team's last qualification (to its first playoff match when it has one);
 *  - lunch: the one longest gap of a day's gaps (not the one before the night or the playoffs) that passes the lunch test above.
 */
export function gaps(schedule: readonly ScheduledMatch[], after: number): Gap[] {
  const quals = schedule.filter((m) => m.level === 'qm').sort((a, b) => a.number - b.number)
  const playoff = schedule.filter((m) => m.level !== 'qm').sort((a, b) => (startOf(a) ?? Infinity) - (startOf(b) ?? Infinity))[0]
  const all: Gap[] = quals.map((m, i) => {
    const nextM = quals[i + 1] ?? playoff
    const [a, b] = [startOf(m), nextM ? startOf(nextM) : null]
    return {
      after: m.number, next: nextM ? { level: nextM.level, number: nextM.number } : null,
      minutes: a !== null && b !== null ? Math.round((b - a) / 60e3) : null, name: null,
    }
  })
  // A day is the run of gaps between nights; its last gap is the one that crosses into the night (or the playoffs).
  const days: Gap[][] = [[]]
  all.forEach((g, i) => {
    const last = i === all.length - 1
    if (last) g.name = 'before playoffs'
    else if (g.minutes !== null && g.minutes >= OVERNIGHT_MINUTES) g.name = 'overnight'
    days.at(-1)!.push(g)
    if (g.name === 'overnight') days.push([])
  })
  for (const day of days) {
    const inside = day.filter((g) => g.name === null && g.minutes !== null)
    if (inside.length < LUNCH_MIN_GAPS) continue
    const sizes = inside.map((g) => g.minutes!).sort((x, y) => x - y)
    const typical = sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2
    const longest = inside.reduce((x, y) => (y.minutes! > x.minutes! ? y : x))
    if (longest.minutes! >= LUNCH_MINUTES && longest.minutes! >= LUNCH_TIMES_TYPICAL * typical) longest.name = 'lunch'
  }
  return all.filter((g) => g.after >= after)
}
