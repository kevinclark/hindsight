/**
 * The team number saved in the desktop app, as something a view can react to. The page opened from disk has no app and no
 * setting: teamNow() is null there, and the robot lists group by team instead (src/ui/robot-list.ts).
 */
import { hub } from '../hub/bridge.ts'

let team = $state<number | null>(null)

export const teamNow = (): number | null => team
export const setTeamNow = (n: number | null) => { team = n }
/** Ask the app once. A page with no app, or an app that does not answer, leaves it unset. */
export async function loadTeam(): Promise<void> {
  try { team = (await hub()?.team())?.team ?? null } catch { team = null }
}
