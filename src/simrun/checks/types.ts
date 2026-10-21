/** What every sim-run check reads and returns. */

import type { WpilogFile } from '../../readers/wpilog.ts'
import type { RunRecord } from '../events.ts'
import type { Run, Zero } from '../scenario.ts'

export interface RunResult {
  run: Run
  record: RunRecord
  /** The run's .wpilog (AdvantageKit's values), or null when none was recorded. */
  log: WpilogFile | null
  /** Which repeat of its scenario and alliance this is (1 unless --repeat). */
  repeat: number
  wallSeconds: number
  /** Still running at its deadline, so sim-run stopped it. */
  killed: boolean
  /** Seconds the computer slept during the run: the simulator runs in real time, so a run that slept says nothing. */
  sleptSeconds: number
}

export interface Context {
  results: RunResult[]
  zeroes: Zero[]
  /** The team's Java package ("frc.robot."), from the main class: stack frames in it are "where in your code". */
  teamPackage: string
  /** The robot pose's log key (a Pose2d), or null when the log has none sim-run can find. */
  poseKey: string | null
}

export interface Finding {
  check: string
  severity: 'error' | 'warning' | 'info'
  /** The run's label. */
  run: string
  message: string
  details: string[]
  /** What to look at in the code. */
  look?: string
}

export type Check = (context: Context) => Finding[]

/**
 * "0.12 s": a duration as sim-run says it. Rules' secs() (src/rules/rule.ts) rounds to 0.1 s, but sim-run's timing is a loop or two
 * (a zero cut off 0.08 s after it started), so under a second it keeps two decimals.
 */
export const duration = (s: number) => `${s < 1 ? s.toFixed(2) : s.toFixed(1)} s`

/** Which runs a finding is about: "every run", "6 runs", or the runs' names when given. */
export function runsLabel(count: number, total: number, names: string[] = []): string {
  if (count === total) return 'every run'
  return names.length ? names.join(', ') : `${count} runs`
}
