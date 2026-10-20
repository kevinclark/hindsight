/**
 * The robot profiles kept in this browser (src/builder/store.ts), as something a view can react to: the builder
 * calls changed() after it keeps or forgets one, and any view reading profilesNow() / keptNow() in a $derived updates.
 */
import type { RobotProfile } from '../profiles/types.ts'
import { keptProfiles, storedProfiles } from '../builder/store.ts'
import type { ProfileJson } from '../builder/json.ts'

let version = $state(0)

export const changed = () => { version++ }
export function profilesNow(): RobotProfile[] { void version; return storedProfiles() }
export function keptNow(): ProfileJson[] { void version; return keptProfiles() }
