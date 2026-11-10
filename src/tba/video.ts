/**
 * The match video: the YouTube link The Blue Alliance holds for a match, opened from Match review. The event is the
 * session's (src/board/event.ts); the match is the log's own label. A qualification joins on its number. An
 * elimination joins on time (FMS and TBA number playoffs differently in some years, src/tba/identify.ts): the match
 * whose actual start is nearest the log's auto start, within 180 s. No video, or any doubt: no link.
 * A finding's link opens at its match time with no offset: in 12 clips auto started 4.4-9.0 s in, so it lands a few seconds early, never late.
 */
import { teamMatchesFull, type TbaMatchFull } from './api.ts'
import type { TbaGet } from './source.ts'

export type { TbaMatchFull }

/** How far (seconds) a log's auto start may be from TBA's actual time for an elimination match to count as the same. */
export const ELIM_WINDOW_SECONDS = 180

export function pickMatch(matches: TbaMatchFull[], kind: 'Qualification' | 'Elimination', number: number, autoEpoch: number | null): TbaMatchFull | null {
  if (kind === 'Qualification') return matches.find((m) => m.comp_level === 'qm' && m.match_number === number) ?? null
  if (kind !== 'Elimination' || autoEpoch === null) return null
  let best: TbaMatchFull | null = null, gap = Infinity
  for (const m of matches) {
    if (m.comp_level === 'qm' || typeof m.actual_time !== 'number') continue
    const d = Math.abs(m.actual_time - autoEpoch)
    if (d < gap) { best = m; gap = d }
  }
  return best && gap <= ELIM_WINDOW_SECONDS ? best : null
}

/** The first YouTube video of a match, or null. The key is checked before it goes into a URL. */
export function youtubeKey(m: TbaMatchFull): string | null {
  const v = m.videos?.find((x) => x?.type === 'youtube')
  return v && /^[A-Za-z0-9_-]{11}$/.test(v.key) ? v.key : null
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
    const m = pickMatch(data, parsed[1] as 'Qualification' | 'Elimination', Number(parsed[2]), autoEpoch)
    return m ? youtubeKey(m) : null
  } catch { return null }
}

export const videoUrl = (key: string): string => `https://www.youtube.com/watch?v=${key}`

/** A finding's link: at floor(matchTime) seconds. None without a video, for a whole-match finding, a negative time, or off the field (`run` set). */
export function watchUrl(key: string | null, f: { matchTime: number | null; run?: number }): string | null {
  if (!key || f.run || f.matchTime === null || f.matchTime < 0) return null
  return `${videoUrl(key)}&t=${Math.max(0, Math.floor(f.matchTime))}s`
}
