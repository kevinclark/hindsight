/**
 * Season or off-season: a date inside the year's kickoff-to-Championship window is season, any other date is
 * off-season. FMS runs at off-season events too, so the window decides, not FMS. Dates are the Championship's last
 * day and the kickoff, local calendar days.
 *
 * Measured against FIRST's pages: 2026 only (kickoff 10 Jan, Houston 29 Apr to 2 May). 2024 and 2025 are from memory and
 * not checked; a year not listed uses the default window, and the Library view says so. Add a year here when FIRST
 * publishes it.
 */

import { GAMES } from '../profiles/games.ts'

interface Window { kickoff: [month: number, day: number]; championshipEnd: [month: number, day: number]; checked: boolean }

/** Kickoffs come from the game table (src/profiles/games.ts), so there is one list of them. */
const kickoff = (year: number) => GAMES.find((g) => g.year === year)!.kickoff
const WINDOWS: Record<number, Window> = {
  2024: { kickoff: kickoff(2024), championshipEnd: [4, 20], checked: false },
  2025: { kickoff: kickoff(2025), championshipEnd: [4, 19], checked: false },
  2026: { kickoff: kickoff(2026), championshipEnd: [5, 2], checked: true },
}
const DEFAULT_WINDOW: Window = { kickoff: [1, 1], championshipEnd: [5, 7], checked: false }

export type Season = 'season' | 'off-season'

export function seasonOf(ms: number): Season {
  const d = new Date(ms)
  const w = WINDOWS[d.getFullYear()] ?? DEFAULT_WINDOW
  const day = (month: number, date: number) => new Date(d.getFullYear(), month - 1, date).getTime()
  const end = day(...w.championshipEnd) + 86400e3
  return ms >= day(...w.kickoff) && ms < end ? 'season' : 'off-season'
}

/** Whether the window for this moment's year was checked against FIRST's pages. */
export function windowChecked(ms: number): boolean {
  return WINDOWS[new Date(ms).getFullYear()]?.checked ?? false
}
