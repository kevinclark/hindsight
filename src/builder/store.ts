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

/** The name a kept profile is known by: unique among kept ones and distinct from the built-in profiles' ids. */
export const keptId = (json: Pick<ProfileJson, 'name' | 'code'>) => `${json.name} @ ${json.code?.branch || 'any branch'} (kept in this browser)`

/** A kept profile as a RobotProfile, carrying its keptId (profiles/index.ts profileId reads it). */
export const keptProfile = (json: ProfileJson): RobotProfile => ({ ...toProfile(json), keptAs: keptId(json) })

/** The kept profiles as RobotProfiles, for chooseProfile and the "use…" lists. */
export function storedProfiles(): RobotProfile[] {
  return keptProfiles().map(keptProfile)
}

/**
 * Keep a profile, replacing the kept one with its name and branch, and `replaces` (the keptId it was opened or last
 * kept as, so a renamed profile replaces itself instead of leaving its old name behind). False when the browser
 * wouldn't store it.
 */
export function keepProfile(json: ProfileJson, replaces?: string | null): boolean {
  const all = keptProfiles().filter((p) => keptId(p) !== keptId(json) && keptId(p) !== replaces)
  try { localStorage.setItem(KEY, JSON.stringify([json, ...all])); return true } catch { return false }
}

export function forgetProfile(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(keptProfiles().filter((p) => keptId(p) !== id))) } catch { /* not kept anyway */ }
}
