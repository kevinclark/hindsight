/**
 * The robots a robot list offers (Session view, Match review). With a team set it shows that team's robots and leaves
 * other teams' out, so a student picks from their own; without one, every robot, grouped by team. Only the lists use this:
 * automatic choice (src/profiles/choose.ts) still sees every profile.
 */
import { profileId } from '../profiles/index.ts'
import type { RobotProfile } from '../profiles/types.ts'

/** `label` null: the list's own robots, with no heading. */
export interface RobotGroup { label: string | null; profiles: RobotProfile[] }

const teamLabel = (p: RobotProfile): string => (p.team === undefined ? 'No team' : `Team ${p.team}`)

/**
 * `team` set: your team's built-in profiles, then kept ones whose team is yours or unset (a kept profile made before profiles
 * had a team shows here); other teams' profiles are left out, except those in `inUse` (profile ids this session's logs use
 * now), which follow under their team's heading so a log's own robot is always in its list.
 * `team` null (not set, or the page has no app): every profile, grouped by team in the order they appear.
 */
export function robotChoices(builtIn: RobotProfile[], kept: RobotProfile[], team: number | null, inUse: string[] = []): RobotGroup[] {
  const all = [...builtIn, ...kept]
  if (team === null) {
    const groups: RobotGroup[] = []
    for (const p of all) {
      const label = teamLabel(p)
      const g = groups.find((x) => x.label === label)
      if (g) g.profiles.push(p)
      else groups.push({ label, profiles: [p] })
    }
    return groups
  }
  const mine = (p: RobotProfile, isKept: boolean) => (isKept ? p.team === undefined || p.team === team : p.team === team)
  const groups: RobotGroup[] = [{ label: null, profiles: [...builtIn.filter((p) => mine(p, false)), ...kept.filter((p) => mine(p, true))] }]
  for (const p of all) {
    if (groups[0].profiles.includes(p) || !inUse.includes(profileId(p))) continue
    const label = teamLabel(p)
    const g = groups.find((x) => x.label === label)
    if (g) g.profiles.push(p)
    else groups.push({ label, profiles: [p] })
  }
  return groups
}
