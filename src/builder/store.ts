/**
 * Robot profiles the student built or dropped, kept in this browser (like ui/robot-choice.ts keeps their robot
 * choice). A private window, or a browser that blocks storage for pages opened from disk, just doesn't keep them:
 * "Save profile.json" is then the only copy.
 */
import type { RobotProfile } from '../profiles/types.ts'
import { parseProfileJson, toProfile, type ProfileJson } from './json.ts'

const KEY = 'hindsight.profiles'

/** Every kept profile.json, newest first. Unreadable entries are skipped. */
export function keptProfiles(): ProfileJson[] {
  let raw: unknown
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
  if (!Array.isArray(raw)) return []
  return raw.flatMap((p) => { try { return [parseProfileJson(JSON.stringify(p))] } catch { return [] } })
}

/** The kept profiles as RobotProfiles, for chooseProfile and the "use…" lists. */
export function storedProfiles(): RobotProfile[] {
  return keptProfiles().map(toProfile)
}

/** The name a kept profile is known by: unique among kept ones and distinct from the built-in profiles' ids. */
export const keptId = (json: Pick<ProfileJson, 'name' | 'code'>) => `${json.name} @ ${json.code?.branch || 'any branch'} (kept in this browser)`

/** Keep (or replace, by name and branch) a profile. False when the browser wouldn't store it. */
export function keepProfile(json: ProfileJson): boolean {
  const all = keptProfiles().filter((p) => keptId(p) !== keptId(json))
  try { localStorage.setItem(KEY, JSON.stringify([json, ...all])); return true } catch { return false }
}

export function forgetProfile(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(keptProfiles().filter((p) => keptId(p) !== id))) } catch { /* not kept anyway */ }
}
