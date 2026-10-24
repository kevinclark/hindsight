/**
 * Where the team is in the event's schedule, and what a deferral points at (ADR 4 and 6). Everything is counted in the
 * team's own match numbers, so a point is named "after Q51 (overnight)", never by a clock time; times only estimate how
 * long a gap is. Pure: the schedule, the session and `now` come in; nothing here reads the clock, the page or the network.
 *
 * A position is a number along the event: a team's qualification N is N, "before N" is N - 0.5, "after N" is N + 0.5,
 * playoff matches follow the qualifications (1000 + their order), the end of the event and the next event come last.
 * Smaller is sooner.
 */
import type { Session } from '../session/session.ts'
import type { MatchSummary } from '../session/summary.ts'
import { qualNumber } from '../tba/identify.ts'
import { gaps, startOf, type Gap, type ScheduledMatch } from '../tba/schedule.ts'
import type { BoardUntil } from '../triage/history.ts'

export const END_OF_EVENT = 1e6
export const NEXT_EVENT = 1e7
const PLAYOFFS = 1000

/** The team's next scheduled match: its label ("Q41", "SF1M1"), its place, when it starts (ms) and, when known, minutes from the previous scheduled match's start (the gap includes the match itself). */
export interface NextMatch {
  label: string
  level: ScheduledMatch['level']
  number: number
  pos: number
  startsAt: number | null
  /** Minutes from the previous scheduled match's start to this one's (the gap, which includes the match itself). */
  minutes: number | null
  /** Minutes left from `now` to its start, when `now` was given and the start is near enough to mean it (within two days). */
  leftMinutes: number | null
}

export interface Timeline {
  /** The team's schedule at this event was read. False: due points read "next match" / "end of the event". */
  hasSchedule: boolean
  /** The team's latest on-field match in the session, as the short label ("Q33") and its qualification number (null for a practice or playoff match). */
  last: { label: string; qual: number | null; playedAt: number | null } | null
  next: NextMatch | null
  /** Position just before the next match: what "due before the next match" means. 0 without a schedule. */
  nextPos: number
  /** The named gaps (lunch, overnight, before playoffs) after the next match, in order. */
  named: Gap[]
  /** Every gap of the team's day (for resolving a stored deferral by match). */
  all: Gap[]
  /** The team's last scheduled qualification, if any. */
  lastQual: number | null
  /** Minutes from the last played scheduled match's start to the last scheduled match's start. */
  toEnd: number | null
  /** The team's playoff matches are on the schedule (so "before playoffs" has a gap to estimate). */
  hasPlayoffs: boolean
  /** When each of the team's qualifications starts (ms), by number; and the moment the board was read (ms), or null. */
  starts: Map<number, number | null>
  now: number | null
}

/** A short name for a scheduled match. */
export function scheduleLabel(m: Pick<ScheduledMatch, 'level' | 'number' | 'set'>): string {
  return m.level === 'qm' ? `Q${m.number}` : `${m.level.toUpperCase()}${m.set}M${m.number}`
}

/** "Qualification 33" -> 33; a label that is not one -> null. */
export const qualOf = (matchLabel: string): number | null => qualNumber(matchLabel)

/** The position of a scheduled match (see the file header). */
function posOf(m: ScheduledMatch, schedule: readonly ScheduledMatch[]): number {
  if (m.level === 'qm') return m.number
  return PLAYOFFS + schedule.filter((x) => x.level !== 'qm').indexOf(m)
}

/** The team's latest on-field match in the session. */
export function lastOnField(session: Pick<Session, 'matches'>): MatchSummary | undefined {
  return session.matches.filter((m) => m.onField).at(-1)
}

/**
 * Where the team stands. `schedule` is `parseSchedule`/`teamSchedule`'s list (null: none was read). The next match is the
 * first scheduled one after the latest on-field log: by qualification number when that log was a qualification, else by
 * time; a match The Blue Alliance already has an actual time for is not next.
 */
export function timeline(session: Pick<Session, 'matches'>, schedule: readonly ScheduledMatch[] | null, shortOf: (m: MatchSummary) => string, now?: number): Timeline {
  const latest = lastOnField(session)
  const last = latest ? { label: shortOf(latest), qual: qualOf(latest.matchLabel), playedAt: latest.playedAt } : null
  if (!schedule || schedule.length === 0) {
    return { hasSchedule: false, last, next: null, nextPos: 0, named: [], all: [], lastQual: null, toEnd: null, hasPlayoffs: false, starts: new Map(), now: now ?? null }
  }
  let from = -1
  if (last?.qual != null) {
    schedule.forEach((m, i) => { if (m.level === 'qm' && m.number <= last.qual!) from = i })
  } else if (last?.playedAt != null) {
    schedule.forEach((m, i) => { const t = startOf(m); if (t !== null && t <= last.playedAt!) from = i })
  } else from = -1
  const unknownWhere = !last || (last.qual == null && last.playedAt == null)
  const nextM = unknownWhere ? undefined : schedule.slice(from + 1).find((m) => m.actual === null)
  const quals = schedule.filter((m) => m.level === 'qm')
  const lastQual = quals.length ? Math.max(...quals.map((m) => m.number)) : null
  const all = gaps(schedule, 0)
  const nextNo = nextM ? (nextM.level === 'qm' ? nextM.number : Infinity) : Infinity
  const named = all.filter((g) => g.name !== null && g.after >= nextNo)
  let minutes: number | null = null
  const prev = from >= 0 ? schedule[from] : undefined
  if (nextM && prev) {
    const [a, b] = [startOf(prev), startOf(nextM)]
    if (a !== null && b !== null && b > a) minutes = Math.round((b - a) / 60e3)
  }
  const end = schedule.at(-1)
  const [t0, t1] = [prev ? startOf(prev) : null, end ? startOf(end) : null]
  const toEnd = t0 !== null && t1 !== null && t1 > t0 ? Math.round((t1 - t0) / 60e3) : null
  const startsAt = nextM ? startOf(nextM) : null
  const next = nextM ? { label: scheduleLabel(nextM), level: nextM.level, number: nextM.number, pos: posOf(nextM, schedule), startsAt, minutes, leftMinutes: minutesFromNow(startsAt, now, 2 * 1440) } : null
  const starts = new Map(quals.map((m) => [m.number, startOf(m)] as const))
  return { hasSchedule: true, last, next, nextPos: next ? next.pos - 0.5 : END_OF_EVENT - 1, named, all, lastQual, toEnd, hasPlayoffs: schedule.some((m) => m.level !== 'qm'), starts, now: now ?? null }
}

/** Minutes from `now` to a start (both ms), or null when either is unknown or the start is not within `within` minutes ahead (a stale clock or a copy of another day). */
export function minutesFromNow(startsAt: number | null | undefined, now: number | undefined | null, within: number): number | null {
  if (startsAt == null || now == null) return null
  const m = Math.round((startsAt - now) / 60e3)
  return m > 0 && m <= within ? m : null
}

/** A place in the event: where it falls, and how a row words it. */
export interface DuePoint {
  pos: number
  /** "before Q41", "after Q51 (overnight)", "before the next match", "the end of the event". */
  text: string
  /** For "Workaround until …" and "re-decide …" on a deferred row. */
  until: string
  redecide: string
  /** The match this is about ("Q41", "Q51"), or null. */
  match: string | null
  /** The event is over (no match left on the schedule): "before the next match" is not true, the line says "open · the event is over". */
  over?: true
}

/** A schedule with no match left on it, playoffs included: the event is over. */
export const eventOver = (tl: Pick<Timeline, 'hasSchedule' | 'next' | 'hasPlayoffs'>): boolean => tl.hasSchedule && !tl.next && tl.hasPlayoffs

const GAP_WORDS: Record<string, string> = { lunch: 'lunch', overnight: 'overnight', 'before playoffs': 'before playoffs' }
export const gapText = (g: Pick<Gap, 'after' | 'name'>): string => `after Q${g.after}${g.name ? ` (${GAP_WORDS[g.name]})` : ''}`

/** The point "before the next match" (red). */
export function beforeNext(tl: Timeline): DuePoint {
  const label = tl.next?.label ?? null
  return { pos: tl.nextPos, text: label ? `before ${label}` : 'before the next match', until: label ?? 'the next match', redecide: label ? `at ${label}` : 'before the next match', match: label, ...(eventOver(tl) ? { over: true as const } : {}) }
}

/** The point at the end of the event. */
export function endOfEvent(tl: Timeline): DuePoint {
  const q = tl.lastQual
  return { pos: END_OF_EVENT, text: 'the end of the event', until: q ? `the end of the event (after Q${q})` : 'the end of the event', redecide: 'at the end of the event', match: q ? `Q${q}` : null }
}

/** The point a gap names. */
export function atGap(g: Pick<Gap, 'after' | 'name'>): DuePoint {
  return { pos: g.after + 0.5, text: gapText(g), until: `the gap ${gapText(g)}`, redecide: 'in that gap', match: `Q${g.after}` }
}

export function beforePlayoffs(tl: Timeline): DuePoint {
  const pos = tl.lastQual !== null ? tl.lastQual + 0.5 : END_OF_EVENT - 2
  return { pos, text: 'before playoffs', until: tl.lastQual !== null ? `playoffs (after Q${tl.lastQual})` : 'playoffs', redecide: 'before playoffs', match: tl.lastQual !== null ? `Q${tl.lastQual}` : null }
}

export const nextEvent = (): DuePoint => ({ pos: NEXT_EVENT, text: 'the next event', until: 'the next event', redecide: 'at the next event', match: null })

/**
 * Due point of an issue that is not deferred (a judgment: the mock invented its due points, ADR 4 names none):
 *  - a red is due before the next match;
 *  - an amber at the next named gap (lunch, overnight, before playoffs) after the next match, else the end of the event;
 *  - a low at the end of the event.
 */
export function dueByPriority(priority: 'red' | 'amber' | 'low', tl: Timeline): DuePoint {
  if (priority === 'red') return beforeNext(tl)
  if (priority === 'amber' && tl.named.length) return atGap(tl.named[0])
  return endOfEvent(tl)
}

/** A string, or undefined (a stored `until` from a hand-edited file or a newer build can hold anything). */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
/** A finite whole number >= 0, or undefined. */
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/** `until` with its match, matches and minutes type-checked: a value of the wrong type is dropped, never trusted (slice 4 review). */
export function readUntil(u: BoardUntil): BoardUntil {
  const [match, matches, minutes] = [str((u as { match?: unknown }).match), count((u as { matches?: unknown }).matches), count((u as { minutes?: unknown }).minutes)]
  return { kind: u.kind, ...(match ? { match } : {}), ...(matches !== undefined ? { matches } : {}), ...(minutes !== undefined ? { minutes } : {}) }
}

/** "Q41" from a stored match ("Q41", or "TEST Q41" as a board line names a match). */
export function qualFromStored(match: string | undefined): number | null {
  const m = match ? /(?:^|\s)Q(\d+)$/.exec(match.trim()) : null
  return m ? Number(m[1]) : null
}

/**
 * What a stored deferral points at. A next-match deferral is the match it names (else the next one); a gap is the gap after
 * the match it names (else the first gap after the next match that is long enough: `minutes`, or `matches` of the team's
 * own matches). Before-elims, end-of-event and next-event are the event's points. A point that cannot be placed (a gap with
 * no match and no length, or one no schedule can find) is placed at the end of the event and says so.
 */
export function resolveUntil(raw: BoardUntil, tl: Timeline): DuePoint {
  const u = readUntil(raw)
  if (u.kind === 'next-match') {
    const n = qualFromStored(u.match)
    if (n !== null) return { pos: n - 0.5, text: `before Q${n}`, until: `Q${n}`, redecide: `at Q${n}`, match: `Q${n}` }
    return beforeNext(tl)
  }
  if (u.kind === 'gap') {
    const n = qualFromStored(u.match)
    if (n !== null) {
      const g = tl.all.find((x) => x.after === n)
      return atGap(g ?? { after: n, name: null })
    }
    const pool = tl.all.filter((g) => g.after >= (tl.next?.level === 'qm' ? tl.next.number : Infinity))
    // A gap's size in matches is the match numbers between the team's two matches (the other teams' matches).
    const long = u.minutes !== undefined ? pool.find((g) => g.minutes !== null && g.minutes >= u.minutes!)
      : u.matches !== undefined ? pool.find((g) => g.next?.level === 'qm' && g.next.number - g.after >= u.matches!) : undefined
    if (long) return atGap(long)
    return { ...endOfEvent(tl), text: 'a later gap (no schedule to place it)', until: 'a later gap (not placed)' }
  }
  if (u.kind === 'before-elims') return beforePlayoffs(tl)
  if (u.kind === 'end-of-event') return endOfEvent(tl)
  return nextEvent()
}

/** "≈ 83 min" / "≈ 16 h 4 min" for an estimate; always followed by "est." where it is shown. */
export function durText(minutes: number): string {
  return minutes >= 120 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`
}

export interface Suggestion {
  /** Stable id for a select. */
  id: string
  label: string
  /** "≈ 83 min, est." or why there is none. */
  estimate: string
  until: BoardUntil
  point: DuePoint
  /** Hindsight's pick for a red. */
  suggested: boolean
  /** Set when the pick is the end of the event because the playoff cut-off has passed and the issue is not red (ADR 7); otherwise the pick is a red's next named gap and this is left out. */
  reason?: 'after the cut-off'
}

/**
 * Where an issue can be deferred to (ADR 6): the next match; the named gaps after it ("the gap after Q51 (overnight,
 * ≈ 16 h, est.)"); before playoffs; the end of the event; the next event; each with its estimated time from the
 * schedule. A red's suggestion is the next named gap, else the next match. Without a schedule: the next match, before
 * playoffs, the end of the event and the next event, with no estimate.
 */
/** One wording for a gap: when it starts, counted from now, and how long it lasts ("starts in ≈ 3 h 20 min, lasts ≈ 27 h 30 min, est."). The start is left out when there is no clock to count from. */
function gapEstimate(tl: Timeline, g: Pick<Gap, 'after' | 'minutes'>): string {
  const startsIn = minutesFromNow(tl.starts.get(g.after), tl.now, 7 * 1440)
  if (g.minutes === null) return startsIn !== null ? `starts in ≈ ${durText(startsIn)}, length unknown, est.` : 'no estimate'
  return startsIn !== null ? `starts in ≈ ${durText(startsIn)}, lasts ≈ ${durText(g.minutes)}, est.` : `lasts ≈ ${durText(g.minutes)}, est.`
}

export function suggestions(tl: Timeline, freeze?: { passed: boolean; red: boolean }): Suggestion[] {
  const out: Suggestion[] = []
  const nextLabel = tl.next?.label
  out.push({
    id: 'next', label: nextLabel ? `Next match (${nextLabel})` : 'Next match',
    estimate: tl.next?.leftMinutes != null ? `≈ ${durText(tl.next.leftMinutes)} from now, est.` : tl.next?.minutes != null && tl.last ? `≈ ${durText(tl.next.minutes)} after ${tl.last.label}, est.` : 'no estimate',
    until: { kind: 'next-match', ...(nextLabel && tl.next?.level === 'qm' ? { match: nextLabel } : {}) }, point: beforeNext(tl), suggested: false,
  })
  const gapsOffered = tl.named.filter((g) => g.name !== 'before playoffs').slice(0, 3)
  for (const g of gapsOffered) {
    out.push({
      id: `gap-${g.after}`, label: `The gap ${gapText(g)}`,
      estimate: gapEstimate(tl, g),
      until: { kind: 'gap', match: `Q${g.after}`, ...(g.minutes !== null ? { minutes: g.minutes } : {}) }, point: atGap(g), suggested: false,
    })
  }
  const bp = beforePlayoffs(tl)
  const bpGap = tl.named.find((g) => g.name === 'before playoffs')
  out.push({
    id: 'playoffs', label: tl.lastQual !== null ? `Before playoffs (after Q${tl.lastQual})` : 'Before playoffs',
    estimate: bpGap ? gapEstimate(tl, bpGap) : tl.hasSchedule ? 'no estimate: no playoff match for the team on the schedule' : 'no estimate',
    until: { kind: 'before-elims' }, point: bp, suggested: false,
  })
  out.push({
    id: 'end', label: tl.lastQual !== null ? `End of the event (after Q${tl.lastQual})` : 'End of the event',
    estimate: tl.toEnd !== null ? `≈ ${durText(tl.toEnd)} to the last scheduled match, est.` : 'no estimate',
    until: { kind: 'end-of-event' }, point: endOfEvent(tl), suggested: false,
  })
  out.push({ id: 'event', label: 'Next event', estimate: 'weeks', until: { kind: 'next-event' }, point: nextEvent(), suggested: false })
  // After the playoff cut-off (ADR 7, Kevin 2026-10-24): fixes are for reds only, so anything that is not red leads with "the end of the event". The rest keep their order; nothing is left out.
  // Once it has passed, "Before playoffs" is behind us whatever the issue (with or without a schedule): it is not offered.
  if (freeze?.passed) {
    const ahead = out.filter((s) => s.id !== 'playoffs')
    if (!freeze.red) {
      const end = ahead.find((s) => s.id === 'end')!
      end.suggested = true
      end.reason = 'after the cut-off'
      return [end, ...ahead.filter((s) => s !== end)]
    }
    const redPick = ahead.find((s) => s.id.startsWith('gap-')) ?? ahead[0]
    redPick.suggested = true
    return ahead
  }
  const pick = out.find((s) => s.id.startsWith('gap-')) ?? out[0]
  pick.suggested = true
  return out
}
