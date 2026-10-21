/**
 * Each auto, run alone on a freshly started robot: its own command should finish before auto ends, and it should
 * move the robot.
 *
 * The auto's own command is the one robot code schedules from autonomousInit, or else, when autos are scheduled by a
 * trigger or a proxy, the commands that need a subsystem, start in the first two loops of auto and that the default
 * auto's run doesn't start. Commands a state machine starts later in auto (an intake group held while the state is
 * INTAKE) and wrappers that need no subsystem (Choreo's routine command, which runs until auto ends by design) are
 * not the auto's: measured on 26Off, the drive sequence starts 0.024 s after enable, the intake state group 0.08 s.
 */

import { describeCommand, lifetimes, signature, type Lifetime, type RunRecord } from '../events.ts'
import { movement, RESET_SETTLE_SECONDS } from './pose.ts'
import { secs, type Check, type Finding } from './types.ts'

/** Measured on 26Off's autos in sim (2026-10-21): driving autos move 8+ m; nothing below 0.3 m counts as moving. */
const MOVED_METERS = 0.3
const TURNED_DEGREES = 15
/** Two robot loops: the auto's command, scheduled through a proxy, starts one loop after enable (measured above). */
const AUTO_START_SECONDS = 0.05

export const autos: Check = ({ results, poseKey }) => {
  const autoRuns = results.filter((r) => r.run.scenario.kind === 'auto')
  return autoRuns.filter((r) => !r.run.scenario.auto?.isDefault && r.record.ended).flatMap((r): Finding[] => {
    const period = r.record.periods.find((p) => p.mode === 'auto')
    if (!period) return []
    const baseline = autoRuns.find((b) => b.run.scenario.auto?.isDefault && b.run.alliance === r.run.alliance)
    const baselineStarts = baseline ? autoCommands(baseline.record, []).map((l) => signature(l.command)) : []
    const findings: Finding[] = []
    const unfinished = autoCommands(r.record, baselineStarts).filter((l) => l.end >= period.end - 0.05)
    if (unfinished.length) {
      findings.push({
        check: 'auto/unfinished', severity: 'warning', run: r.run.label,
        message: `The auto was still running when auto ended (${secs(period.end - period.start)}).`,
        details: unfinished.map((l) => `still running: ${describeCommand(l.command)}`),
        look: "the auto's steps: a path, a wait or a shot that never ends",
      })
    }
    const moved = movement(r.log, poseKey, period.start + RESET_SETTLE_SECONDS, period.end)
    if (moved && moved.distance < MOVED_METERS && Math.abs(moved.headingEnd - moved.headingStart) < TURNED_DEGREES) {
      findings.push({
        check: 'auto/did-not-move', severity: 'warning', run: r.run.label,
        message: `The robot didn't move in this auto (${moved.distance.toFixed(2)} m).`,
        details: [],
        look: "the auto's drive commands and the trajectory it loads",
      })
    }
    return findings
  })
}

/** The auto's own commands in a run (see the top of this file), leaving out ones the default auto also starts. */
function autoCommands(record: RunRecord, baselineStarts: string[]): Lifetime[] {
  const auto = record.periods.find((p) => p.mode === 'auto')
  if (!auto) return []
  const started = lifetimes(record).filter((l) => !l.command.isDefault && l.start >= auto.start && l.start < auto.end)
  const fromAutonomousInit = started.filter((l) => l.command.origin.includes('autonomousInit'))
  if (fromAutonomousInit.length) return fromAutonomousInit
  return started.filter((l) => l.start <= auto.start + AUTO_START_SECONDS && l.command.requirements.length > 0 && !baselineStarts.includes(signature(l.command)))
}
