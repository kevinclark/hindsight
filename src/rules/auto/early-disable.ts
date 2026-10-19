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
import { rule, round, type Problem } from '../rule.ts'
import type { MatchView } from '../view.ts'

const TILTED_DEGREES = 15 // the same line as collision/tilt
const FULL_AUTO_SLACK = 1 // an auto run within 1 s of the auto length counts as run to the end (assumed)

/** Every auto period run with this auto chosen, in a log, before robot time `until`. */
function runsOf(log: MatchView, name: string, until: number) {
  if (!log.has('autoChoice')) return []
  const choice = log.text('autoChoice')
  const dirty = /uncommitted/i.test(log.build.dirty)
  return log.auto.filter((iv) => iv.start < until && choice.at(iv.start) === name).map((iv) => ({
    log, start: iv.start, seconds: iv.end - iv.start, sha: log.build.sha, dirty, onField: log.has('fmsAttached') && log.signal('fmsAttached').at(iv.start) > 0.5,
  }))
}

/** What this log says about the chosen auto's history (empty if it doesn't log the chooser). */
function autoHistory(match: MatchView, start: number): { evidence: Record<string, string | number>; firstOnBuild: boolean } {
  if (!match.has('autoChoice')) return { evidence: {}, firstOnBuild: false }
  const name = match.text('autoChoice').at(start)
  // No auto chosen: an empty name would match every log's auto before its chooser was logged.
  if (!name) return { evidence: { auto: '(none chosen)' }, firstOnBuild: false }
  const here = runsOf(match, name, start)
  const myClock = match.wallClock(start)
  // Other loaded logs, earlier by the robot's wall clock (logs with no clock can't be placed).
  const others = myClock === null ? [] : match.otherLogs().flatMap((o) => runsOf(o, name, Infinity).filter((r) => (o.wallClock(r.start) ?? Infinity) < myClock))
  others.sort((a, b) => a.log.wallClock(a.start)! - b.log.wallClock(b.start)!)
  const sha = match.build.sha.slice(0, 7)
  const runs = [...others, ...here]
  const onBuild = runs.filter((r) => r.sha === match.build.sha && r.dirty === /uncommitted/i.test(match.build.dirty)).length
  const last = runs.at(-1)
  const ended = (r: NonNullable<typeof last>) => (r.seconds >= r.log.profile.game.autoSeconds - FULL_AUTO_SLACK ? 'ran the whole auto' : `ended after ${r.seconds.toFixed(1)} s`)
  const evidence: Record<string, string | number> = {
    auto: name,
    'runs of it earlier in this log': here.length,
    'runs of it in the other logs loaded, earlier': match.otherLogs().length === 0 ? 'not known (only this log is loaded)' : myClock === null ? 'not known (the robot clock was not set)' : others.length,
    // With no other logs loaded, the count would only cover this log.
    [`runs of it on this build (${sha || 'unknown'}), in the logs loaded`]: match.otherLogs().length === 0 && here.length === 0 ? 'not known (only this log is loaded)' : onBuild,
    ...(last ? { 'its last earlier run': `${last.log === match ? 'this log' : last.log.raw.fileName}, ${last.onField ? 'on the field' : 'off the field'}, build ${last.sha.slice(0, 7) || 'unknown'}${last.dirty ? ' with uncommitted changes' : ''}: ${ended(last)}` } : {}),
  }
  // Only when an earlier run on another build was seen: loaded logs that are all later prove nothing.
  return { evidence, firstOnBuild: onBuild === 0 && others.length > 0 }
}

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
    if (!match.onField || match.autoStart === null) return
    const attached = match.signal('dsAttached')
    const autoPeriods = match.auto.filter((a) => a.start >= match.autoStart! && a.start < match.autoStart! + match.profile.game.autoSeconds)
    const early = autoPeriods.filter((a) => match.timeLeft(a.end) > 1 && attached.at(a.end + 0.05) > 0.5)
    // The plot is a bonus: draw the gyro if the log has it, but don't let a missing gyro stop the rule.
    const gyro = match.has('gyroPitch') && match.has('gyroRoll')
      ? [match.signal('gyroPitch').times(180 / Math.PI, 'Pitch'), match.signal('gyroRoll').times(180 / Math.PI, 'Roll')] : []
    return early.map((a): Problem => {
      // How far did it tilt in the 3 s before the disable? Past the collision/tilt line, it probably hit something.
      const lastSeconds = match.before(a.end, 3)
      const tilt = Math.max(0, ...gyro.map((axis) => Math.max(Math.abs(axis.lowest(lastSeconds).value), Math.abs(axis.highest(lastSeconds).value))))
      const wedged = tilt > TILTED_DEGREES
      const history = autoHistory(match, a.start)
      return {
        // The last instant of auto: at a.end itself the robot already reads as disabled.
        message: `Disabled in auto at ${match.when(a.end - 0.001)} with ${match.timeLeft(a.end).toFixed(1)} s of auto left`,
        at: a.end - 0.001,
        likely: wedged ? ['wedged'] : history.firstOnBuild ? ['new-auto'] : undefined,
        nextStep: wedged ? `The robot tilted ${tilt.toFixed(0)}° in the 3 s before the disable: watch the video for what it hit, and add a guard in code near that spot.` : undefined,
        // Context only: how much auto was left when it was disabled ("× the line" would read as how bad it was).
        measured: [{ label: 'left in auto when disabled', value: round(match.timeLeft(a.end), 1), unit: 's' }],
        evidence: { 'auto enabled (robot time, s)': round(match.autoStart!), 'disabled (robot time, s)': round(a.end), 'auto time left (s)': round(match.timeLeft(a.end), 1), 'DS still attached': 'yes', ...history.evidence },
        plot: gyro,
        plotUnit: '°', plotFrom: match.autoStart! - 1, plotTo: a.end + 4, plotMarks: [a.end],
      }
    })
  },
})
