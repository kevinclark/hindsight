/**
 * Slow loops: the overruns WPILib reported while the robot program ran, and the steps its timing lines name
 * (`SwerveSubsystem.periodic(): 0.077s`, read with Hindsight's own loop/overrun parser). A Mac is not a roboRIO: the
 * count says where time goes, not whether the robot will overrun.
 */

import { plural } from '../../rules/rule.ts'
import { describeSteps, slowStepsIn } from '../../rules/loop/tracer-steps.ts'
import type { ConsoleLine } from '../events.ts'
import { runsLabel, type Check, type Finding } from './types.ts'

const OVERRUN = /loop overrun|Loop time of .* overrun/
/** Measured on 26Off: both start-up overruns are in the first loops, within 1 s of the program starting. */
const START_UP_SECONDS = 1

export const loops: Check = ({ results }) => {
  const withOverruns = results.filter((r) => r.record.console.some((l) => OVERRUN.test(l.text)))
  const findings: Finding[] = withOverruns.flatMap((r): Finding[] => {
    const afterStartUp = r.record.console.filter((l) => r.record.started !== null && l.t > r.record.started + START_UP_SECONDS)
    const later = afterStartUp.filter((l) => OVERRUN.test(l.text))
    if (later.length === 0) return []
    return [{
      check: 'loop/overruns', severity: 'info', run: r.run.label,
      message: `${plural(later.length, 'loop overrun')} after start-up (on this computer, not a roboRIO).`,
      details: slowest(afterStartUp),
    }]
  })
  if (withOverruns.length) {
    findings.push({
      check: 'loop/start-up', severity: 'info', run: runsLabel(withOverruns.length, results.length),
      message: 'Loop overruns while the robot program started (normal; on this computer, not a roboRIO).',
      details: slowest(withOverruns[0].record.console),
    })
  }
  return findings
}

/** "slowest: SwerveSubsystem.periodic() in 2 overrun loops, worst 61 ms", or nothing when no step was slow. */
function slowest(lines: ConsoleLine[]): string[] {
  const steps = slowStepsIn(lines.map((l) => l.text))
  return steps.length ? [`slowest: ${describeSteps(steps)}`] : []
}
