/**
 * Which robot profile fits a log. In order:
 *   1. the profile the student chose for it;
 *   2. a profile for the robot the log names (its Codebase), pinned to the branch the log ran;
 *   3. a profile for that robot pinned to another branch (with a note: limits may differ);
 *   4. the profile with the most of its signals in the log (with a note, and a warning when under 60 % fit).
 */
import { hasEntry, readValues, type WpilogFile } from '../readers/wpilog.ts'
import type { RobotProfile } from './types.ts'
import { DATALOGMANAGER_SIGNALS } from './datalogmanager.ts'

export interface ProfileChoice {
  how: 'chosen by you' | 'codebase and branch' | 'codebase' | 'signals' | 'given'
  /** What the student should know about the choice, or null when it is a clean match. */
  note: string | null
  /** How many of the profile's signals are in the log. */
  fit: { present: number; total: number } | null
  /**
   * The profile doesn't fit this log (under 60 % of its signals): the rules about specific motors, devices, cameras
   * and mechanisms aren't run, and the match's auto and teleop lengths are measured from the log.
   */
  misfit?: boolean
}

/** Below this share of the profile's signals, the log is probably from another robot or another year's code. */
export const PROFILE_FIT_MIN = 0.6

/** Keys every plain WPILib log has (DS:, NT:/FMSInfo, systemTime, console): they say nothing about which robot it is. */
const GENERIC = new Set(Object.values(DATALOGMANAGER_SIGNALS).filter((k): k is string => typeof k === 'string'))

/**
 * Every signal the profile names (alert groups are folders of signals, not signals, so they don't count), less the
 * keys any plain WPILib log has: otherwise a profile made mostly of those would fit every such log. The e-stop flag,
 * match clock, auto chooser and joystick keys are left out too: every AdvantageKit log has them, whatever the robot.
 */
export function profileKeys(profile: RobotProfile): string[] {
  const { alertGroups: _, emergencyStop: _e, matchTimeLeft: _m, autoChoice: _a, joystickButtonCounts: _j, ...signals } = profile.signals
  const keys = [
    ...profile.motorGroups.flatMap((g) => g.motors.flatMap((m) => [m.supplyCurrent, m.statorCurrent, m.velocity, m.connected, m.temperature])),
    ...profile.cameras.flatMap((c) => [c.acceptedPose, c.connected]),
    ...Object.values(signals),
  ]
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && k !== '' && !GENERIC.has(k)))]
}

export function profileFit(log: WpilogFile, profile: RobotProfile): { present: number; total: number } {
  const keys = profileKeys(profile)
  return { present: keys.filter((k) => hasEntry(log, k)).length, total: keys.length }
}

const MISFIT_TEXT = 'So the rules about specific motors, devices, cameras and mechanisms were not run, and the auto and teleop lengths were measured from this log.'

const first = (log: WpilogFile, key: string) => readValues<string>(log, key)?.v[0] ?? ''

export function chooseProfile(log: WpilogFile, profiles: RobotProfile[], chosen?: RobotProfile): { profile: RobotProfile; choice: ProfileChoice } {
  const fitText = (f: { present: number; total: number }) => `${f.present} of its ${f.total} signals are in this log`
  const low = (f: { present: number; total: number }) => f.present < PROFILE_FIT_MIN * f.total
  if (chosen) {
    const fit = profileFit(log, chosen)
    return { profile: chosen, choice: { how: 'chosen by you', fit, misfit: low(fit), note: low(fit) ? `You chose "${chosen.name}", but only ${fitText(fit)}. ${MISFIT_TEXT}` : null } }
  }
  const codebase = first(log, '/RealMetadata/Codebase')
  const branch = first(log, '/RealMetadata/GitBranch')
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
  const named = codebase ? `The code in this log calls itself "${codebase}", and no profile is for that robot` : 'This log does not say which robot it is from (no Codebase entry)'
  return {
    profile: best.p,
    choice: {
      how: 'signals', fit: best.fit, misfit: low(best.fit),
      note: `${named}; using "${best.p.name}", which fits best: ${fitText(best.fit)}.${low(best.fit) ? ` ${MISFIT_TEXT} Add a profile for this robot, or choose one.` : ''}`,
    },
  }
}
