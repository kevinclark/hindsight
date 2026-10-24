import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

/**
 * The team's own match logs, for the tests and scripts that read real logs. Their paths are listed in an untracked
 * file on the Mac that has them ($HINDSIGHT_TEAM_LOGS, else ~/.hindsight/team-logs.json), never in the repo: a log's
 * name carries its event and match, and these tests say what happened in each one. A log that isn't listed reads as
 * missing, so its tests skip.
 *
 *   logA, logADslog  a 2026 match with an auto collision and comms loss, and its Driver Station log
 *   logB             a 2026 match with slow flywheel followers
 *   logC             a 2026 match that browned out
 *   event2026        the folder of that 2026 event's logs; event2026Files names the ones tests pick out
 *   event2025        the folder of the 2025 robot's event logs; event2025Files names the ones tests pick out
 *   robot2023, robot2024  one log from each of those robots
 */
export type TeamLogs = {
  logA?: string; logADslog?: string; logB?: string; logC?: string
  event2026?: string; event2026Files?: Record<string, string>; event2025?: string; event2025Files?: Record<string, string | string[]>
  robot2023?: string; robot2024?: string
}

export const TEAM_LOGS_FILE = process.env.HINDSIGHT_TEAM_LOGS ?? `${homedir()}/.hindsight/team-logs.json`
export const TEAM: TeamLogs = readTeamLogs()

/** A list that can't be read counts as empty, with a warning, so it skips the real-log tests instead of failing every file. */
function readTeamLogs(): TeamLogs {
  if (!existsSync(TEAM_LOGS_FILE)) return {}
  try {
    return JSON.parse(readFileSync(TEAM_LOGS_FILE, 'utf8')) as TeamLogs
  } catch (e) {
    console.warn(`IGNORED ${TEAM_LOGS_FILE}: ${(e as Error).message}`)
    return {}
  }
}

/** A listed path, or one that never exists when it isn't listed. */
export const teamPath = (p: string | undefined): string => p ?? '/not-listed-in-team-logs.json'
