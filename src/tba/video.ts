/**
 * The match video: the YouTube link The Blue Alliance holds for a match, opened from Match review. The event is the
 * session's (src/board/event.ts); the match is the log's own label. A qualification joins on its number. An
 * elimination joins by number too, for 2023 on (double elimination: FMS numbers 1-13 are the bracket's sf{N}m1, 14 up
 * the finals f1m{N-13}); if both The Blue Alliance's actual time and the log's auto start are known they must agree
 * within 180 s. TBA lacks actual_time for many offseason playoffs, so time alone would link too few. No video, or any
 * doubt: no link.
 * A finding's link opens at its match time with no offset: in 12 clips auto started 4.4-9.0 s in, so it lands a few
 * seconds early, never late.
 */
import { teamMatchesFull, type TbaMatchFull } from './api.ts'
import type { TbaGet } from './source.ts'
import { EVENT_GAP, type EventLog } from './identify.ts'
import type { LogRecord } from '../hub/types.ts'

export type { TbaMatchFull }

/** How far (seconds) a log's auto start may be from TBA's actual time for an elimination match to count as the same. */
export const ELIM_WINDOW_SECONDS = 180

export function pickMatch(matches: TbaMatchFull[], kind: 'Qualification' | 'Elimination', number: number, autoEpoch: number | null, eventKey: string): TbaMatchFull | null {
  if (kind === 'Qualification') return matches.find((m) => m.comp_level === 'qm' && m.match_number === number) ?? null
  if (kind !== 'Elimination' || Number(eventKey.slice(0, 4)) < 2023) return null
  const suffix = number <= 13 ? `sf${number}m1` : `f1m${number - 13}`
  const m = matches.find((x) => x.key === `${eventKey}_${suffix}`)
  if (!m) return null
  if (typeof m.actual_time === 'number' && autoEpoch !== null && Math.abs(m.actual_time - autoEpoch) > ELIM_WINDOW_SECONDS) return null
  return m
}

/** The first YouTube video of a match, or null. The key is checked before it goes into a URL. */
export function youtubeKey(m: TbaMatchFull): string | null {
  return m.videos?.find((x) => x?.type === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(x.key))?.key ?? null
}

/**
 * The video of the match a log is, or null. `label` is the log's "Qualification 28" / "Elimination 3"; `autoEpoch` the wall time
 * (seconds since 1970) of its auto start. Never throws: a lookup that fails is no link.
 */
export async function matchVideoKey(get: TbaGet, team: number, eventKey: string, eventEnd: string | undefined, label: string, autoEpoch: number | null): Promise<string | null> {
  const parsed = /^(Qualification|Elimination) (\d+)$/.exec(label.trim())
  if (!parsed) return null
  try {
    const { data } = await teamMatchesFull(get, team, eventKey, eventEnd)
    const m = pickMatch(data, parsed[1] as 'Qualification' | 'Elimination', Number(parsed[2]), autoEpoch, eventKey)
    return m ? youtubeKey(m) : null
  } catch { return null }
}

export const videoUrl = (key: string): string => `https://www.youtube.com/watch?v=${key}`

/** A finding's link: at floor(matchTime) seconds. None without a video, for a whole-match finding, a negative time, or off the field (`run` set). */
export function watchUrl(key: string | null, f: { matchTime: number | null; run?: number }): string | null {
  if (!key || f.run || f.matchTime === null || f.matchTime < 0) return null
  return `${videoUrl(key)}&t=${Math.floor(f.matchTime)}s`
}

/** Whether `matchTime` counts from the start of auto: a restart piece's matchStart is its first enable, not an auto start. */
export const startedInAuto = (m: { matchStart: number | null; auto: { start: number }[] }): boolean =>
  m.matchStart !== null && m.auto.some((a) => a.start === m.matchStart)

/**
 * For a log opened from the Library with no loaded session: its record (found by any of its names) and the on-field robot logs
 * played within EVENT_GAP of it, shaped for `identifyEvents` the way the Library does (file name = sha-256, no event name, a
 * "Qualification N" label for FMS type 2). Null when the log is not a dated, on-field, non-stub robot log.
 */
export function libraryEventLogs(records: LogRecord[], name: string): { sha: string; logs: EventLog[] } | null {
  const usable = (r: LogRecord) => r.kind === 'wpilog' && !r.stub && r.onField && r.playedAt !== null
  const open = records.find((r) => r.names.includes(name))
  if (!open || !usable(open)) return null
  const logs = records.filter((r) => usable(r) && Math.abs(r.playedAt! - open.playedAt!) < EVENT_GAP).map((r) => ({
    fileName: r.sha256, playedAt: r.playedAt, onField: r.onField, event: '',
    matchLabel: r.matchType === 2 && r.matchNumber ? `Qualification ${r.matchNumber}` : '',
  }))
  return { sha: open.sha256, logs }
}
