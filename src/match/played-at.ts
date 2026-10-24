/** When a match was played: the robot clock when it is believable, else the date in an AdvantageKit file name. */
import type { Match } from './match.ts'

/** Before FRC robots logged with AdvantageKit's dated names, a clock this early is certainly unset. */
const EARLIEST_PLAUSIBLE = Date.UTC(2023, 0, 1)
/** A roboRIO 2 whose clock was never set reads its image date, 2024-12-18: treat that day (± 1) as unset. */
const UNSET_CLOCK_DAY = Date.UTC(2024, 11, 18)

export interface PlayedAt {
  playedAt: number | null
  playedAtSource: 'robot clock' | 'file name' | 'unknown'
  /** Why the date came from somewhere other than the robot clock, or null. */
  clockNote: string | null
}

/** When the match was played: the robot clock if it was set, else the date in an AdvantageKit file name. */
export function playedAt(match: Match): PlayedAt {
  const fromName = dateFromFileName(match.fileName)
  const start = match.matchStart ?? match.logStart
  const fromClock = match.epochOffset !== null ? (match.epochOffset + start) * 1000 : null
  const clockOk = fromClock !== null && fromClock >= EARLIEST_PLAUSIBLE && Math.abs(fromClock - UNSET_CLOCK_DAY) > 86400e3
  if (clockOk && (fromName === null || Math.abs(fromClock - fromName) < 2 * 86400e3)) {
    return { playedAt: fromClock, playedAtSource: 'robot clock', clockNote: null }
  }
  if (fromName !== null) {
    return {
      playedAt: fromName, playedAtSource: 'file name',
      clockNote: clockOk ? 'The robot clock disagrees with the file name by more than 2 days; using the file name.' : 'The robot clock was not set; the date comes from the file name.',
    }
  }
  return { playedAt: null, playedAtSource: 'unknown', clockNote: 'The robot clock was not set and the file name has no date: put this log in a session by hand.' }
}

/** AdvantageKit names logs akit_YY-MM-DD_HH-MM-SS…; read that as UTC (AdvantageKit uses the roboRIO's UTC clock). */
export function dateFromFileName(name: string): number | null {
  const m = /(\d{2})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  const t = Date.UTC(2000 + y, mo - 1, d, h, mi, s)
  return Number.isFinite(t) && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? t : null
}
