/**
 * Hindsight's own log rules on a sim run's log, and what sim-run takes from the robot profile that fits the log (its
 * zeroes, pose key, auto chooser, auto length). Rules whose findings are artifacts of running in sim are left out,
 * each with the reason, so a student isn't sent chasing them.
 */

import { analyzeFiles } from '../analyze.ts'
import type { Match } from '../match/match.ts'
import type { Finding as RuleFinding } from '../rules/types.ts'
import type { Zero } from './scenario.ts'

/**
 * Rules left out, each with why. The first three fire on every sim run and mean nothing about the robot (measured on
 * 26Off, 2026-10-20/21); meta/not-checked lists the rules a sim log has nothing for, which is most power and vision.
 */
export const LEFT_OUT: Record<string, string> = {
  'vision/stale': 'simulated cameras deliver results about 34 % of the time in every sim run',
  'build/dirty': "sim-run's own copy of the code",
  'power/pd-not-reporting': 'the simulator reports a REV power hub whatever the robot has',
  'meta/not-checked': 'most power and vision rules have nothing to read in a sim log',
}

export interface ProfileFacts {
  profileName: string
  zeroes: Zero[]
  poseKey: string | null
  /** The auto chooser's SmartDashboard key ("Autos"), from the profile's autoChoice key. */
  chooser: string | null
  autoSeconds: number | null
}

/** The rule findings for one run's log, sim artifacts left out, and the match (for the profile it was read with). */
export function hindsightOn(fileName: string, bytes: Uint8Array): { findings: RuleFinding[]; match: Match } | null {
  const analysis = analyzeFiles([{ name: fileName, bytes }]).analyses[0]
  if (!analysis) return null
  return { findings: analysis.report.findings.filter((f) => !(f.rule in LEFT_OUT)), match: analysis.match }
}

/**
 * What sim-run uses from the profile the log was matched with, or null when the log doesn't name that profile's
 * robot. A profile picked only because its signals fit best is another robot's: measured, four other robots' sim logs
 * were matched to an 8033 profile that way, which would have given them its auto chooser and zeroes.
 */
export function profileFacts(match: Match): ProfileFacts | null {
  const { profile, profileChoice } = match
  if (profileChoice.how !== 'codebase' && profileChoice.how !== 'codebase and branch') return null
  const chooserKey = profile.signals.autoChoice
  return {
    profileName: profile.name,
    zeroes: profile.zeroing.map((z) => ({ name: z.mechanism.toLowerCase(), done: z.doneMessage, once: false, fromFile: false })),
    poseKey: profile.signals.odometryPose || null,
    chooser: chooserKey ? chooserKey.split('/').filter(Boolean).pop() ?? null : null,
    autoSeconds: profile.game.autoSeconds ?? null,
  }
}
