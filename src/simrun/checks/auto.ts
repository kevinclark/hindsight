/**
 * Each auto, run alone on a freshly started robot: whether its own command finished before auto ended (a note: some
 * autos hold an alignment to the end on purpose), and whether it moved the robot.
 *
 * The auto's own command is the one robot code schedules from autonomousInit, or else, when autos are scheduled by a
 * trigger or a proxy, the commands that need a subsystem, start in the first two loops of auto and that the default
 * auto's run doesn't start. Commands a state machine starts later in auto (an intake group held while the state is
 * INTAKE) and wrappers that need no subsystem (Choreo's routine command, which runs until auto ends by design) are
 * not the auto's. Measured (2026-10-21): the auto's drive sequence starts 0.025–0.047 s after enable (26Off n = 11,
 * Rebuilt), the intake state group 0.083–0.136 s.
 */

import { describeCommand, signature, type Lifetime, type RunRecord } from '../events.ts'
import { movement, RESET_SETTLE_SECONDS } from './pose.ts'
import { duration, type Check, type Finding, type RunResult } from './types.ts'

/** Assumed: under 0.3 m is standing still (26Off's autos moved about 1 m in sim after their start-pose reset). */
const MOVED_METERS = 0.3
const TURNED_DEGREES = 15
/** Between the drive sequence's latest start and the state group's earliest (measured above). */
const AUTO_START_SECONDS = 0.07

export const autos: Check = ({ results, poseKey }) => {
  const autoRuns = results.filter((r) => r.run.scenario.kind === 'auto')
  const chosen = autoRuns.filter((r) => !r.run.scenario.auto?.isDefault && r.record.ended)
  const unselected = chosen.filter((r) => selectionNotTaken(r))
  // None took: sim-run can't select on this robot, which is one thing to say, not one per run.
  if (unselected.length > 1 && unselected.length === chosen.length) return [noneTaken(unselected)]
  return chosen.flatMap((r): Finding[] => {
    const period = r.record.periods.find((p) => p.mode === 'auto')
    if (!period) return []
    const notSelected = selectionNotTaken(r)
    if (notSelected) return [notSelected]
    const baseline = autoRuns.find((b) => b.run.scenario.auto?.isDefault && b.run.alliance === r.run.alliance)
    const baselineStarts = baseline ? autoCommands(baseline.record, []).map((l) => signature(l.command)) : []
    const findings: Finding[] = []
    const unfinished = autoCommands(r.record, baselineStarts).filter((l) => l.how !== 'finished' || l.end >= period.end)
    if (unfinished.length) {
      findings.push({
        // A note, not a warning: in the precision run 4 of 4 on one robot were real (two 7 s shots can't fit), and 36 of
        // 36 on another were autos that hold a climb alignment to the end on purpose.
        check: 'auto/unfinished', severity: 'info', run: r.run.label,
        message: `The auto was still running when auto ended (${duration(period.end - period.start)}): fine if it holds something on purpose (aiming, a climb), a problem if a step never finishes.`,
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

/**
 * The robot didn't take the selection: its chooser's active option before auto isn't the one sim-run selected
 * (measured on a 2022 robot: every option ran the default auto). The run's other auto findings would be the wrong
 * auto's, so it gets this one instead.
 */
export function selectionNotTaken(r: RunResult): Finding | null {
  const wanted = r.run.scenario.auto
  if (!wanted) return null
  const lastSeen = r.record.choosers.filter((c) => c.key === wanted.chooser).at(-1)
  if (!lastSeen || lastSeen.active === '' || lastSeen.active === wanted.option) return null
  return {
    check: 'auto/not-selected', severity: 'warning', run: r.run.label,
    message: `The robot didn't take the auto sim-run selected: its chooser still said "${lastSeen.active}" when auto started, so this run says nothing about "${wanted.option}".`,
    details: [],
    look: NOT_TAKEN_LOOK,
  }
}

/**
 * WPILib 2022's chooser listens only for a dashboard's write, not one made inside the robot program, which is how
 * sim-run selects (measured: on a 2022 robot all 16 runs kept the default; read from WPILib 2022's SendableBuilderImpl).
 */
const NOT_TAKEN_LOOK = "on WPILib 2022 and earlier sim-run can't select a SendableChooser (it listens only for a dashboard), so this is sim-run's limit, not your code; from 2023 on: how the code reads the chooser (read once at start-up, or a custom chooser)"

function noneTaken(runs: RunResult[]): Finding {
  return {
    check: 'auto/not-selected', severity: 'warning', run: `${runs.length} auto runs`,
    message: `The robot didn't take any auto sim-run selected, so the auto runs say nothing about the autos they were for.`,
    details: [],
    look: NOT_TAKEN_LOOK,
  }
}

/** The auto's own commands in a run (see the top of this file), leaving out ones the default auto also starts. */
function autoCommands(record: RunRecord, baselineStarts: string[]): Lifetime[] {
  const auto = record.periods.find((p) => p.mode === 'auto')
  if (!auto) return []
  const started = record.lives.filter((l) => !l.command.isDefault && l.start >= auto.start && l.start < auto.end)
  const fromAutonomousInit = started.filter((l) => l.command.origin.includes('autonomousInit'))
  if (fromAutonomousInit.length) return fromAutonomousInit
  return started.filter((l) => l.start <= auto.start + AUTO_START_SECONDS && l.command.requirements.length > 0 && !baselineStarts.includes(signature(l.command)))
}
