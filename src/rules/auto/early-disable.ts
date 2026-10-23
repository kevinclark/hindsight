/**
 * Was the robot disabled during auto with time left, on the field?
 *
 * Checks: on the field (FMS attached), an auto period that ends more than 1 s early while the DS is still attached.
 * That is a deliberate disable (an A-stop or the drive team), not a comms loss.
 * Why: CalGames 2026 Q13: the robot wedged under the trench and was disabled with 7.4 s of auto left.
 *
 * Evidence: which auto was chosen, and its earlier runs in this log and in the other logs loaded with it: how many,
 * how many on this build, and how the last one ended. MTTD 2025 Q28's "Left stack auto" was disabled after 1.0 s; it
 * had run once before, in Friday practice p8, on a different build with uncommitted changes.
 * "Not run before on this build" is marked likely only when an earlier run on another build was actually seen in the
 * loaded logs (a judgment: a new build is a suspect, not a proof). Two builds of one commit with different
 * uncommitted changes can't be told apart.
 */
import { isUncommitted } from '../../match/git-dirty.ts'
import { rule, round, secs } from '../rule.ts'
import type { MatchView, Signal, Window } from '../view.ts'

const TILTED_DEGREES = 15 // the same line as collision/tilt
const FULL_AUTO_SLACK = 1 // an auto run within 1 s of the auto length counts as run to the end (assumed)

export default rule({
  id: 'auto/early-disable',
  title: 'Disabled during auto',
  severity: 'error',
  who: ['software', 'drive'],
  meaning: 'The robot was disabled partway through auto while the Driver Station was still connected, so a person or the field turned it off on purpose. It was not a comms loss.',
  causes: [
    { id: 'a-stop', cause: 'The drive team pressed A-stop or disabled it because the robot was stuck, headed somewhere wrong or unsafe', look: 'ask the drive team what they saw; the match video at this time' },
    { id: 'wedged', cause: 'The robot hit or wedged on a field element (it tilted, then stopped)', look: 'Match tab: pitch and roll just before the disable; the collision/tilt finding for this match' },
    { id: 'mechanism', cause: 'A mechanism was out of position (a failed zero, a stuck arm or intake)', look: 'the mech/zero-not-completed finding; the mechanism\'s position in AdvantageScope just before the disable' },
    { id: 'field', cause: 'The field or a referee disabled the robot', look: 'ask the head referee or FTA why; the field log for this match' },
    { id: 'new-auto', cause: 'The auto had not run before on this build: new or changed code ran in a match for the first time', look: 'the evidence below (earlier runs of this auto and their builds); git log between those builds and this one' },
  ],
  nextStep: 'Ask the drive team why they disabled it, then check what happened in the seconds before: tilt, a mechanism out of position, a stuck path.',
  incident: 'CalGames 2026 Q13: disabled at 282.7 s with 7.4 s of auto left after the hood hit the trench (2026-10-17-calgames-q13-log-analysis.md §1)',

  check(match) {
    const autoStart = match.autoStart
    if (!match.onField) return match.couldNotCheck('not a match on the field')
    if (autoStart === null) return match.couldNotCheck('the robot never enabled in auto')
    const attached = match.signal('dsAttached')
    const autoEnd = autoStart + match.profile.game.autoSeconds
    const autoPeriods = match.auto.filter((a) => a.start >= autoStart && a.start < autoEnd)
    const early = autoPeriods.filter((a) => match.timeLeft(a.end) > 1 && attached.at(a.end + 0.05) > 0.5)
    // The plot is a bonus: draw the gyro if the log has it, but don't let a missing gyro stop the rule.
    const pitch = match.signalIfLogged('gyroPitch')
    const roll = match.signalIfLogged('gyroRoll')
    const gyro = pitch && roll ? [pitch.inDegrees('Pitch'), roll.inDegrees('Roll')] : []

    return early.map((a) => {
      const timeLeft = match.timeLeft(a.end)
      // How far did it tilt in the 3 s before the disable? Past the collision/tilt line, it probably hit something.
      const tilt = tiltIn(gyro, match.before(a.end, 3))
      const wedged = tilt > TILTED_DEGREES
      const history = autoHistory(match, a.start)

      let likely: string[] | undefined
      if (wedged) {
        likely = ['wedged']
      } else if (history.firstOnBuild) {
        likely = ['new-auto']
      }

      return {
        // The last instant of auto: at a.end itself the robot already reads as disabled.
        message: `Disabled in auto ${match.whenAt(a.end - 0.001)} with ${secs(timeLeft)} of auto left`,
        at: a.end - 0.001,
        likely,
        nextStep: wedged ? `The robot tilted ${tilt.toFixed(0)}° in the 3 s before the disable: watch the video for what it hit, and add a guard in code near that spot.` : undefined,
        // Context only: how much auto was left when it was disabled ("× the line" would read as how bad it was).
        measured: [{ label: 'left in auto when disabled', value: round(timeLeft, 1), unit: 's' }],
        evidence: {
          'auto enabled (robot time, s)': round(autoStart),
          'disabled (robot time, s)': round(a.end),
          'auto time left (s)': round(timeLeft, 1),
          'DS still attached': 'yes',
          ...history.evidence,
        },
        plot: { signals: gyro, unit: '°', from: autoStart - 1, to: a.end + 4, marks: [a.end] },
      }
    })
  },
})

/** One run of an auto period in a log. */
interface Run {
  log: MatchView
  start: number
  seconds: number
  sha: string
  dirty: boolean
  onField: boolean
}

/** Every auto period run with this auto chosen, in a log, before robot time `until`. */
function runsOf(log: MatchView, name: string, until: number): Run[] {
  if (!log.has('autoChoice')) return []
  const choice = log.text('autoChoice')
  const dirty = isUncommitted(log.build.dirty)
  return log.auto.filter((iv) => iv.start < until && choice.at(iv.start) === name).map((iv) => ({
    log,
    start: iv.start,
    seconds: iv.end - iv.start,
    sha: log.build.sha,
    dirty,
    onField: log.has('fmsAttached') && log.signal('fmsAttached').at(iv.start) > 0.5,
  }))
}

/** Runs of this auto in the other loaded logs that began earlier, by the robot's wall clock, oldest first. */
function earlierRunsInOtherLogs(match: MatchView, name: string, myClock: number | null): Run[] {
  // Logs with no clock can't be placed.
  if (myClock === null) return []
  return match.otherLogs()
    .flatMap((o) => runsOf(o, name, Infinity).map((run) => ({ run, clock: o.wallClock(run.start) ?? Infinity })))
    .filter((r) => r.clock < myClock)
    .sort((a, b) => a.clock - b.clock)
    .map((r) => r.run)
}

/** How the last earlier run ended: it ran to the end of auto (within a second), or was cut off. */
function describeLastRun(last: Run, match: MatchView): string {
  const where = last.log === match ? 'this log' : last.log.raw.fileName
  const field = last.onField ? 'on the field' : 'off the field'
  const dirty = last.dirty ? ' with uncommitted changes' : ''
  const ran = last.seconds >= last.log.profile.game.autoSeconds - FULL_AUTO_SLACK
  const ended = ran ? 'ran the whole auto' : `ended after ${secs(last.seconds)}`
  return `${where}, ${field}, build ${last.sha.slice(0, 7) || 'unknown'}${dirty}: ${ended}`
}

/** What this log says about the chosen auto's history (empty if it doesn't log the chooser). */
function autoHistory(match: MatchView, start: number) {
  if (!match.has('autoChoice')) return { evidence: {}, firstOnBuild: false }
  const name = match.text('autoChoice').at(start)
  // No auto chosen: an empty name would match every log's auto before its chooser was logged.
  if (!name) return { evidence: { auto: '(none chosen)' }, firstOnBuild: false }

  const here = runsOf(match, name, start)
  const myClock = match.wallClock(start)
  const others = earlierRunsInOtherLogs(match, name, myClock)
  const onlyThisLog = match.otherLogs().length === 0
  const sha = match.build.sha.slice(0, 7)
  const runs = [...others, ...here]
  const buildIsDirty = isUncommitted(match.build.dirty)
  const onBuild = runs.filter((r) => r.sha === match.build.sha && r.dirty === buildIsDirty).length
  const last = runs.at(-1)

  let othersCount: string | number = others.length
  if (onlyThisLog) {
    othersCount = 'not known (only this log is loaded)'
  } else if (myClock === null) {
    othersCount = 'not known (the robot clock was not set)'
  }
  // With no other logs loaded, the count would only cover this log.
  const onBuildCount = onlyThisLog && here.length === 0 ? 'not known (only this log is loaded)' : onBuild

  const evidence = {
    auto: name,
    'runs of it earlier in this log': here.length,
    'runs of it in the other logs loaded, earlier': othersCount,
    [`runs of it on this build (${sha || 'unknown'}), in the logs loaded`]: onBuildCount,
    'its last earlier run': last ? describeLastRun(last, match) : undefined,
  }
  // Only when an earlier run on another build was seen: loaded logs that are all later prove nothing.
  return { evidence, firstOnBuild: onBuild === 0 && others.length > 0 }
}

/** How far the robot tilted (degrees, either way, any axis) within the window; 0 with no gyro. */
function tiltIn(gyro: Signal[], window: Window): number {
  const swings = gyro.map((axis) => Math.max(Math.abs(axis.lowest(window).value), Math.abs(axis.highest(window).value)))
  return Math.max(0, ...swings)
}
