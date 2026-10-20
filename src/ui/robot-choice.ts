/**
 * The robot a student chose for a log, when the automatic choice was wrong. Kept in this browser by file name, so
 * Match review and the Session view agree.
 */
import { PROFILES, profileId } from '../profiles/index.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { storedProfiles } from '../builder/store.ts'

const KEY = 'hindsight.chosenRobot'

function read(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}

/** The profile chosen for this log, if any (and if that profile still exists: a built-in one, or one kept in this browser). */
export function chosenRobot(fileName: string): RobotProfile | undefined {
  const id = read()[fileName]
  return id ? [...PROFILES, ...storedProfiles()].find((p) => profileId(p) === id) : undefined
}

/** Choose a profile for these logs; null goes back to choosing automatically. */
export function chooseRobot(fileNames: string[], id: string | null) {
  const all = read()
  for (const f of fileNames) { if (id) all[f] = id; else delete all[f] }
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* private window: not remembered */ }
}

export const HOW_WORDS: Record<string, string> = {
  'chosen by you': 'chosen by you',
  'codebase and branch': 'the log names this robot and branch',
  codebase: 'the log names this robot',
  signals: 'best fit by signals',
  given: 'set by the caller',
}
