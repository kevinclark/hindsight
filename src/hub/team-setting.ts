/** The team number and GitHub sources the user saves in the Library page: checked here, in the main process and in tests. No `node:` imports. */
import { validSource } from './types.ts'

export interface TeamSetting {
  /** The FRC team number, or null when none is set. */
  team: number | null
  /** GitHub organizations (name) or repositories (owner/name) whose code logs are linked to. */
  sources: string[]
}

/** A team number is a whole number from 1 to 99999. */
export const validTeam = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 99999

/** What the page sent, checked: throws an Error in plain words naming the first thing wrong. Empty or null team means none. */
export function checkTeamSetting(team: unknown, sources: unknown): TeamSetting {
  if (team !== null && team !== undefined && team !== '' && !validTeam(team)) throw new Error('A team number is a whole number from 1 to 99999.')
  const clean = [...new Set((Array.isArray(sources) ? sources : []).map((s) => String(s).trim()).filter(Boolean))]
  const bad = clean.find((s) => !validSource(s))
  if (bad) throw new Error(`"${bad}" is not a GitHub organization (name) or repository (owner/name).`)
  return { team: validTeam(team) ? team : null, sources: clean }
}
