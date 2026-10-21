/**
 * The slow steps of overrun loops, read from the robot console.
 *
 * WPILib's Watchdog prints one "epoch" line per step (for example `SwerveSubsystem.periodic(): 0.018531s`), but only
 * in a loop that overran. Those lines are the only place the log says which step was slow.
 */
import { plural, round } from '../rule.ts'
import { inside, type MatchView, type Window } from '../view.ts'

// Assumed, not measured: half of a 20 ms loop. A step over this is a big share of the time we have.
export const SLOW_STEP_MS = 10

/** robotPeriodic() holds the CommandScheduler's steps, so it is named only when no step inside it is. */
const OUTER_STEP = 'robotPeriodic()'

export interface SlowStep {
  name: string
  /** Epoch lines over SLOW_STEP_MS: one per overrun loop the step was slow in. */
  loops: number
  worstMs: number
}

// A line that ends "<Name>(): <seconds>s". The epoch can follow a "Warning at ...: " prefix and a tab on the same
// line, and a command's name can have spaces in it ("Teleop drive.execute()" in CalGames Q13).
const EPOCH_LINE = /([^\t]+?\(\)): (\d+(?:\.\d+)?)s\s*$/

/** The steps over SLOW_STEP_MS in the console lines inside the window, slowest first (none without a console). */
export function slowSteps(match: MatchView, window: Window): SlowStep[] {
  if (!match.has('console')) return []
  const console = match.text('console').series
  const byName = new Map<string, SlowStep>()
  for (let i = 0; i < console.t.length; i++) {
    if (!inside(window, console.t[i])) continue
    for (const line of console.v[i].split(/\r?\n/)) {
      const epoch = EPOCH_LINE.exec(line)
      if (!epoch) continue
      const ms = 1000 * Number(epoch[2])
      if (ms <= SLOW_STEP_MS) continue
      const step = byName.get(epoch[1]) ?? { name: epoch[1], loops: 0, worstMs: 0 }
      step.loops++
      step.worstMs = Math.max(step.worstMs, ms)
      byName.set(epoch[1], step)
    }
  }
  const steps = [...byName.values()]
  const others = steps.filter((s) => s.name !== OUTER_STEP)
  const named = others.length > 0 ? others : steps
  return named.sort((a, b) => b.worstMs - a.worstMs)
}

/** The three slowest steps as one line: the first with its unit ("in 12 overrun loops"), the rest shorter. */
export function describeSteps(steps: SlowStep[]): string {
  return steps.slice(0, 3).map((s, i) => {
    const loops = i === 0 ? plural(s.loops, 'overrun loop') : `${s.loops}`
    return `${s.name} in ${loops}, worst ${round(s.worstMs, 1)} ms`
  }).join('; ')
}

/** The next step when the console names the slowest step: start there. */
export function startWith(step: SlowStep): string {
  const tookLong = `${plural(step.loops, 'overrun loop')} (worst ${round(step.worstMs, 1)} ms)`
  return `Start with ${step.name}: it took over ${SLOW_STEP_MS} ms in ${tookLong}. Move its slow work off the main loop or cache it.`
}
