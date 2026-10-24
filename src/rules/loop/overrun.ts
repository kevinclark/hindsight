/**
 * Is the robot code finishing each loop in 20 ms?
 *
 * Checks: the share of loops over 20 ms (/RealOutputs/LoggedRobot/FullCycleMS), the 99th percentile and the worst,
 * in auto and in teleop. Fires when either overruns on more than 10 % of loops.
 * Why: 2026 offseason event: 14–27 % of auto loops overran (worst 134 ms). A 130 ms loop at 2.5 m/s is 0.33 m of blind
 * travel on a trench approach.
 */
import { maxOf, pct, round, rule } from '../rule.ts'
import { ADVANTAGEKIT_LOGGING, CD_LOOP_OVERRUN } from '../sources.ts'
import { describeSteps, SLOW_STEP_MS, slowSteps, startWith } from './tracer-steps.ts'

export default rule({
  id: 'loop/overrun',
  title: 'Loop overruns',
  severity: 'warning',
  judges: 'performance',
  who: ['software'],
  meaning: 'The robot code often took longer than 20 ms to finish one loop. While it is late the robot runs blind, and a late loop can be many centimeters of travel.',
  causes: [
    { id: 'heavy-work', cause: 'Heavy work inside periodic (vision, path planning, file or network calls)', look: 'the Tracer/* entries in AdvantageScope: which step takes the longest? The code file for that subsystem\'s periodic()' },
    { id: 'gc', cause: 'Garbage collection pauses (the code makes lots of new objects every loop)', look: 'the plot: isolated spikes with a normal loop in between; look for "new" inside periodic code' },
    { id: 'logging', cause: 'Logging too many values, or a slow USB drive', look: 'how many keys are logged; whether the spikes line up with the log flushing; try a different USB drive' },
    { id: 'cpu', cause: 'The roboRIO is overloaded (other programs, too many threads or CAN calls)', look: '/SystemStats CPU use and CAN utilization in AdvantageScope' },
  ],
  nextStep: 'Use the Tracer/* entries to find the slow step in auto and move it off the main loop or cache it.',
  incident: '2026 offseason event: auto overran 14–27 % of loops, worst 134 ms',
  sources: [
    { ...ADVANTAGEKIT_LOGGING, says: 'LoggedRobot/FullCycleMS records the time of all periodic code and should be less than the loop period, 20 ms by default.' },
    { ...CD_LOOP_OVERRUN, says: 'A loop overrun means something in the code runs slower than it should; it is a warning that does not itself disable motors (the separate Watchdog Not Fed error does).' },
  ],
  thresholds: [
    { name: 'loop time', value: '20 ms', basis: 'judgment', how: 'The default loop period (AdvantageKit docs), not measured.' },
    { name: 'share of loops over 20 ms', value: 'more than 10 %', basis: 'judgment', how: 'Chosen. At the 2026 offseason event 14 to 27 % of auto loops overran.' },
    { name: 'share that points at heavy code', value: 'over 20 %, or a median loop over 20 ms', basis: 'judgment', how: 'Chosen.' },
  ],

  check(match) {
    const loop = match.signal('loopCycleMs')
    const auto = loop.samples(match.auto)
    const teleop = loop.samples(match.teleop)
    if (auto.length === 0 && teleop.length === 0) {
      return match.couldNotCheck(match.enabled.length === 0 ? 'the robot was never enabled' : 'no loop times logged in auto or teleop')
    }
    const autoShare = shareOver20ms(auto)
    const teleopShare = shareOver20ms(teleop)

    // Judge whichever period was worse.
    const worst = autoShare >= teleopShare
      ? { name: 'auto', samples: auto, share: autoShare, window: match.auto }
      : { name: 'teleop', samples: teleop, share: teleopShare, window: match.teleop }
    if (worst.share <= 0.1) return

    // Late in over 20 % of loops, or a late middle loop: the loop is too heavy (the work, or the CPU). Less often
    // than that: the work is still the first suspect, then pauses (garbage collection).
    const middle = loop.percentile(50, worst.window)
    const tooHeavy = middle > 20 || worst.share > 0.2

    // The robot console names the slow steps (when the log has it, and only for loops that overran).
    const steps = slowSteps(match, worst.window)
    const slowest = steps[0]

    return {
      likely: tooHeavy ? ['heavy-work', 'cpu'] : ['heavy-work', 'gc'],
      message: `${pct(worst.share)} of ${worst.name} loops took longer than 20 ms (worst ${maxOf(worst.samples).toFixed(0)} ms)`,
      evidence: {
        [`${worst.name}: median loop (ms)`]: round(middle, 1),
        'auto: share over 20 ms (%)': round(100 * autoShare, 1),
        'auto: p99 (ms)': round(loop.percentile(99, match.auto), 0),
        'auto: worst (ms)': round(maxOf(auto), 0),
        'teleop: share over 20 ms (%)': round(100 * teleopShare, 1),
        'teleop: p99 (ms)': round(loop.percentile(99, match.teleop), 0),
        'teleop: worst (ms)': round(maxOf(teleop), 0),
        [`slow steps over ${SLOW_STEP_MS} ms (console)`]: slowest ? describeSteps(steps) : undefined,
      },
      nextStep: slowest ? startWith(slowest) : undefined,
      measured: [{ label: `${worst.name} loops over 20 ms`, value: round(100 * worst.share, 1), unit: '%', threshold: 10 }],
      plot: {
        signals: [loop], unit: 'ms', line: { value: 20, label: '20 ms' },
        from: worst.window[0]?.start, to: worst.window[0]?.end,
      },
    }
  },
})

/** The fraction of loop times longer than 20 ms (0 when there are none). */
function shareOver20ms(loopTimesMs: number[]): number {
  if (loopTimesMs.length === 0) return 0
  return loopTimesMs.filter((ms) => ms > 20).length / loopTimesMs.length
}
