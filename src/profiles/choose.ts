/**
 * Which robot profile fits a log. In order:
 *   1. the profile the student chose for it;
 *   2. a profile for the robot the log names (its Codebase, or ProjectName), pinned to the branch the log ran;
 *   3. a profile for that robot pinned to another branch (with a note: limits may differ);
 *   4. the profile with the most of its signals in the log (with a note), when at least 60 % of them are in it;
 *   5. else no robot's profile: the log is read with the standard signals found in it (ownSignals), so nothing from a
 *      profile already shown not to be this robot's (its motors, cameras, battery keys, code) is applied.
 */
import { hasEntry, type WpilogFile } from '../readers/wpilog.ts'
import type { RobotProfile } from './types.ts'
import { codeIdentity, KEYS_SAME_ON_EVERY_ROBOT, NAMES_SAME_ON_EVERY_ROBOT } from './formats.ts'
import { isOtherLogKey, keysOf } from './sources.ts'
import { signalsFromLog } from '../builder/signals.ts'
import { toProfile } from '../builder/json.ts'

export interface ProfileChoice {
  how: 'chosen by you' | 'codebase and branch' | 'codebase' | 'signals' | 'given'
  /** What the student should know about the choice, or null when it is a clean match. */
  note: string | null
  /** How many of the profile's signals are in the log. */
  fit: { present: number; total: number } | null
  /**
   * The profile doesn't fit this log (under 60 % of its signals): the rules about specific motors, devices, cameras
   * and mechanisms aren't run, and the match's auto and teleop lengths are its season's game (profiles/games.ts),
   * measured from the log when it has no date or predates the first game listed.
   */
  misfit?: boolean
  /** The code name the log gives itself (its Codebase, or ProjectName), when the choice was by signals. */
  codebase?: string
}

/** Below this share of the profile's signals, the log is probably from another robot or another year's code. */
export const PROFILE_FIT_MIN = 0.6


/**
 * Every signal the profile names, less what doesn't tell robots apart: the signals and keys a log type keeps in the
 * same place on every robot (formats.ts, sameOnEveryRobot), otherwise a profile made mostly of those would fit every
 * such log, and Driver Station log sources (not in the robot log). Alert groups are folders of signals, not signals.
 */
export function profileKeys(profile: RobotProfile): string[] {
  const { alertGroups: _, ...signals } = profile.signals
  const robotSignals = Object.entries(signals).filter(([name]) => !NAMES_SAME_ON_EVERY_ROBOT.has(name as never))
  const keys = [
    ...profile.motorGroups.flatMap((g) => g.motors.flatMap((m) => [m.supplyCurrent, m.statorCurrent, m.velocity, m.connected, m.temperature])),
    ...profile.cameras.flatMap((c) => [c.acceptedPose, c.connected]),
    ...robotSignals.flatMap(([, source]) => keysOf(source)),
  ]
  const named = keys.filter((k): k is string => typeof k === 'string' && k !== '')
  const robotKeys = named.filter((k) => !KEYS_SAME_ON_EVERY_ROBOT.has(k) && !isOtherLogKey(k))
  return [...new Set(robotKeys)]
}

export function profileFit(log: WpilogFile, profile: RobotProfile): { present: number; total: number } {
  const keys = profileKeys(profile)
  return { present: keys.filter((k) => hasEntry(log, k)).length, total: keys.length }
}

type RobotPick = { how: ProfileChoice['how']; misfit?: boolean; codebase?: string }

/** Whether the profile picked for a log names its robot: not when it is only a best guess by signals that doesn't fit. */
export const namesRobot = (choice: RobotPick): boolean => choice.how !== 'signals' || !choice.misfit

/**
 * The robot to name for a log. A best guess by signals that doesn't fit is not the robot (the library says the same,
 * src/hub/describe.ts robotIdentity): the log's own code name stands in, marked as one.
 */
export function robotName(profileName: string, choice: RobotPick): string {
  if (namesRobot(choice)) return profileName
  return choice.codebase ? `${choice.codebase} (code name)` : 'unnamed robot'
}

/**
 * A profile with only the standard signals the log has (builder/signals.ts): no motors, cameras or devices, and the
 * code the log says it ran. A signal the builder picks by shape from several candidates waits for a person there, so it
 * is left out here (seen on a 2023 robot: one chooser reads "none" while the auto that ran is on another one).
 * Named as robotName names a misfit, so a place that shows the profile's name says the same.
 */
function ownSignals(log: WpilogFile, codebase: string): RobotProfile {
  const sig = signalsFromLog(log, new Set())
  const signals = { ...sig.signals }
  for (const name of Object.keys(sig.alternatives) as (keyof typeof signals)[]) (signals as Record<string, unknown>)[name] = ''
  return toProfile({ name: robotName('', { how: 'signals', misfit: true, codebase }), motorGroups: [], signals, battery: sig.battery, codebase, code: sig.code })
}

const RULES_NOT_RUN = 'the rules about specific motors, devices, cameras and mechanisms were not run, and the auto and teleop lengths are the season\'s game (measured from this log when it has no date or predates 2023).'
const MISFIT_TEXT = `So ${RULES_NOT_RUN}`


export function chooseProfile(log: WpilogFile, profiles: RobotProfile[], chosen?: RobotProfile): { profile: RobotProfile; choice: ProfileChoice } {
  const fitText = (f: { present: number; total: number }) => `${f.present} of its ${f.total} signals are in this log`
  const low = (f: { present: number; total: number }) => f.present < PROFILE_FIT_MIN * f.total
  if (chosen) {
    const fit = profileFit(log, chosen)
    return { profile: chosen, choice: { how: 'chosen by you', fit, misfit: low(fit), note: low(fit) ? `You chose "${chosen.name}", but only ${fitText(fit)}. ${MISFIT_TEXT}` : null } }
  }
  const { codebase, branch } = codeIdentity(log)
  const sameRobot = profiles.filter((p) => codebase && p.codebase === codebase)
  const pinned = sameRobot.find((p) => p.code.branch === branch || (branch && p.code.alsoBranches?.includes(branch)))
  if (pinned) {
    const fit = profileFit(log, pinned)
    return { profile: pinned, choice: { how: 'codebase and branch', fit, misfit: low(fit), note: low(fit) ? `This log names "${pinned.name}" on ${branch}, but only ${fitText(fit)}: the profile may need updating. ${MISFIT_TEXT}` : null } }
  }
  if (sameRobot.length) {
    const p = sameRobot.find((x) => x.code.branch === 'main') ?? sameRobot[0]
    return {
      profile: p,
      choice: {
        how: 'codebase', fit: profileFit(log, p), misfit: low(profileFit(log, p)),
        note: `No profile is pinned to the branch this log ran (${branch || 'unknown'}); using "${p.name}" as of ${p.code.branch} ${p.code.sha}. Current limits may differ from what ran.`,
      },
    }
  }
  const share = (f: { present: number; total: number }) => (f.total ? f.present / f.total : 0)
  const ranked = profiles.map((p) => ({ p, fit: profileFit(log, p) })).sort((a, b) => share(b.fit) - share(a.fit))
  const best = ranked[0]
  const named = codebase ? `The code in this log calls itself "${codebase}", and no profile is for that robot` : 'This log does not say which robot it is from (no Codebase or ProjectName entry)'
  if (low(best.fit)) {
    return {
      profile: ownSignals(log, codebase),
      choice: {
        how: 'signals', fit: best.fit, misfit: true, codebase,
        note: `${named}; none fits it (the closest, "${best.p.name}", has ${best.fit.present} of its ${best.fit.total} signals in this log), so it is read with only the standard signals found in it: ${RULES_NOT_RUN} Add a profile for this robot, or choose one.`,
      },
    }
  }
  return { profile: best.p, choice: { how: 'signals', fit: best.fit, misfit: false, codebase, note: `${named}; using "${best.p.name}", which fits best: ${fitText(best.fit)}.` } }
}
