/**
 * Hindsight's own log rules on a sim run's log, and what sim-run takes from the robot profile that fits the log (its
 * zeroes, pose key, auto chooser, auto length). Rules whose findings are artifacts of running in sim are left out,
 * each with the reason, so a student isn't sent chasing them.
 */

import { analyzeFiles } from '../analyze.ts'
import type { Match } from '../match/match.ts'
import type { Finding as RuleFinding } from '../rules/types.ts'
import type { Zero } from './scenario.ts'

/** Measured on 26Off sim runs (2026-10-20/21): these fire on every sim run and mean nothing about the robot. */
export const SIM_ARTIFACTS: Record<string, string> = {
  'vision/stale': 'simulated cameras deliver results about 34 % of the time in every sim run',
  'build/dirty': "sim-run's own copy of the code",
  'power/pd-not-reporting': 'the simulator reports a REV power hub whatever the robot has',
  'meta/not-checked': 'a list of rules a sim log has nothing for',
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
  return { findings: analysis.report.findings.filter((f) => !(f.rule in SIM_ARTIFACTS)), match: analysis.match }
}

/** What sim-run uses from the profile the log was matched with. */
export function profileFacts(match: Match): ProfileFacts {
  const { profile } = match
  const chooserKey = profile.signals.autoChoice
  return {
    profileName: profile.name,
    zeroes: profile.zeroing.map((z) => ({ name: z.mechanism.toLowerCase(), done: z.doneMessage, once: false, fromFile: false })),
    poseKey: profile.signals.odometryPose || null,
    chooser: chooserKey ? chooserKey.split('/').filter(Boolean).pop() ?? null : null,
    autoSeconds: profile.game.autoSeconds ?? null,
  }
}
