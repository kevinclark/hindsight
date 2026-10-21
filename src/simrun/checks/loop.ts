/**
 * Slow loops and printed errors: what the robot program itself complained about while it kept running.
 *
 * Loop overruns are counted from WPILib's own "loop overrun" lines, and the slowest steps are read from the timing
 * lines it prints after them ("\tSwerveSubsystem.periodic(): 0.077s"). A Mac is not a roboRIO: the count says
 * where time goes, not whether the robot will overrun.
 */

import { type Check, type Finding } from './types.ts'

const OVERRUN = /loop overrun|Loop time of .* overrun/
const EPOCH = /^\s+(.+?): (\d+\.\d+)s$/
/** WPILib prints every step it times; only the ones this slow are worth naming. */
const SLOW_STEP_SECONDS = 0.005
const TOP_STEPS = 3
/** Measured on 26Off: both start-up overruns are in the first loops, within 1 s of the program starting. */
const START_UP_SECONDS = 1

export const loops: Check = ({ results }) => {
  const runs = results.map((r) => ({ r, overruns: r.record.console.filter((l) => OVERRUN.test(l.text)) })).filter((x) => x.overruns.length)
  const steady = runs.map(({ r, overruns }) => ({ r, later: overruns.filter((l) => r.record.started !== null && l.t > r.record.started + START_UP_SECONDS) }))
  const findings: Finding[] = steady.filter((x) => x.later.length).map(({ r, later }) => ({
    check: 'loop/overruns', severity: 'info', run: r.run.label,
    message: `${later.length} loop overrun${later.length === 1 ? '' : 's'} after start-up (on this computer, not a roboRIO).`,
    details: slowestSteps(r.record.console.filter((l) => l.t > (r.record.started ?? 0) + START_UP_SECONDS)),
  }))
  if (runs.length) {
    const first = runs[0].r
    findings.push({
      check: 'loop/start-up', severity: 'info', run: runs.length === results.length ? 'every run' : `${runs.length} runs`,
      message: 'Loop overruns while the robot program started (normal; on this computer, not a roboRIO).',
      details: slowestSteps(first.record.console),
    })
  }
  return findings
}

/** The slowest steps WPILib's timing lines name, slowest first: "slowest: SwerveSubsystem.periodic() 60 ms". */
function slowestSteps(lines: { text: string }[]): string[] {
  const slowest = new Map<string, number>()
  for (const l of lines) {
    const epoch = EPOCH.exec(l.text)
    if (epoch && Number(epoch[2]) >= SLOW_STEP_SECONDS) slowest.set(epoch[1], Math.max(slowest.get(epoch[1]) ?? 0, Number(epoch[2])))
  }
  return [...slowest].sort((a, b) => b[1] - a[1]).slice(0, TOP_STEPS).map(([step, s]) => `slowest: ${step} ${(s * 1000).toFixed(0)} ms`)
}

/** "Error at ...: message" the robot printed and kept running after: once per message across all runs. */
export const printedErrors: Check = ({ results }) => {
  const seen = new Map<string, string[]>()
  // A run that crashed is the crash check's; its "Error at" lines are the crash.
  for (const r of results.filter((x) => x.record.ended)) {
    for (const l of r.record.console) {
      const error = /^Error at ([^:]+): (.*)$/.exec(l.text.trim())
      if (!error) continue
      const runs = seen.get(l.text.trim()) ?? []
      if (!runs.includes(r.run.label)) runs.push(r.run.label)
      seen.set(l.text.trim(), runs)
    }
  }
  return [...seen].map(([text, runs]) => ({
    check: 'robot/printed-error', severity: 'info', run: runs.length === results.length ? 'every run' : runs.join(', '),
    message: 'The robot code printed an error and kept running.',
    details: [text],
  }))
}
