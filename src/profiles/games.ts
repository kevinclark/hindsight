/**
 * The FRC game each season played: its kickoff and the lengths of auto and teleop. A log is played under the game of
 * the latest kickoff before it (an offseason event in October still plays that year's game), so a draft profile takes
 * its lengths from here rather than from one log, which may be a practice run or a match cut short.
 *
 * Kickoffs 2023-2026 and the 2024-2026 lengths were compared with FIRST's announcements and game overviews
 * (`checked`). 2023's lengths come from 8033's logs: 27 FMS matches, auto 15 s in all, teleop 135 s in 26. Add a row
 * when FIRST announces a game; until then a log after the last row is assumed to play its game, and says so.
 */
export interface FrcGame {
  year: number
  kickoff: [month: number, day: number]
  name: string
  autoSeconds: number
  teleopSeconds: number
  checked: boolean
}

export const GAMES: FrcGame[] = [
  { year: 2023, kickoff: [1, 7], name: '2023 CHARGED UP', autoSeconds: 15, teleopSeconds: 135, checked: false },
  { year: 2024, kickoff: [1, 6], name: '2024 CRESCENDO', autoSeconds: 15, teleopSeconds: 135, checked: true },
  { year: 2025, kickoff: [1, 4], name: '2025 REEFSCAPE', autoSeconds: 15, teleopSeconds: 135, checked: true },
  { year: 2026, kickoff: [1, 10], name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140, checked: true },
]

/** Kickoff day at local midnight. */
export const kickoffOf = (g: Pick<FrcGame, 'year' | 'kickoff'>) => new Date(g.year, g.kickoff[0] - 1, g.kickoff[1]).getTime()

/**
 * The game a moment was played under: the latest kickoff on or before it. `assumed`: the moment is in a later calendar
 * year than the last game listed, so a newer game may have started. Null before the first kickoff listed.
 */
export function gameFor(ms: number): { game: FrcGame; assumed: boolean } | null {
  const game = GAMES.filter((g) => kickoffOf(g) <= ms).at(-1)
  return game ? { game, assumed: new Date(ms).getFullYear() > GAMES.at(-1)!.year } : null
}
