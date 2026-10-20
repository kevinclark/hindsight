/**
 * Did the robot program stop while the robot was enabled, off the field?
 *
 * Checks: a log that ends with the robot still enabled and the field (FMS) not attached. A program stops logging only
 * when it dies, so the robot was enabled when it stopped: someone deployed or restarted the code, the roboRIO lost
 * power, the code crashed, or the robot was switched off without disabling it first. On the field,
 * loop/restart-mid-match covers it. With the next log loaded too, it says how soon the next program started and which
 * commit it ran: a different commit points at a redeploy.
 * Measured on the practice logs of 2026-02-19..22: 28 of 170 end enabled, none with a crash message. In 24 of them
 * the next program logged its first record 10.1–10.6 s after starting. 104 of that week's 158 restarts were that
 * quick, 96 of them within 20 s of the previous log; the other 54 took 12.2–33 s, 48 of them after a gap of 20 s or
 * more, as after switching on. So most look like the program restarting on a running roboRIO (a deploy or a code
 * restart), not a power loss; the log alone can't prove which. A battery above 9 V in the last 2 s (assumed, as
 * restart-mid-match) rules out a sag.
 * Why: 2026-02-21 practice: two logs end while driving at 12.4–12.5 V with no exception in the console. One of them
 * (21-20-58) was followed by a commit made during that run, so it was most likely a redeploy.
 */
import { round, rule, secs, volts } from '../rule.ts'
import type { MatchView } from '../view.ts'

const SLOW_SAG_VOLTS = 9 // above this in the last 2 s, the battery wasn't sagging toward a roboRIO reset (assumed)
const CRASH_SECONDS = 5 // a crash message this close to the end of the log counts (assumed)
const NEXT_RUN_SECONDS = 300 // a log that starts within 5 min of this one's end is the next run (assumed)
const CRASH_TEXT = /Unhandled exception|Robots should not quit|Exception in thread/

export default rule({
  id: 'loop/stopped-while-enabled',
  title: 'Robot program stopped while enabled',
  severity: 'warning',
  who: ['pit', 'software'],
  meaning: 'The log ends with the robot still enabled: the robot program stopped while the robot was driving. Deploying code while enabled does this; so does a loose roboRIO power wire, which on the field would cost the rest of the match.',
  causes: [
    { id: 'redeploy', cause: 'Someone deployed code, or restarted the robot code, while the robot was enabled', look: 'the next log\'s commit (Build line in this app); ask who was deploying' },
    { id: 'power', cause: 'The roboRIO lost power for an instant (its power wires or connector, the battery lead, the main breaker)', look: 'tug-test the roboRIO power connector and wires, the battery connector and the main breaker while the robot is on' },
    { id: 'crash', cause: 'The robot code crashed (an uncaught exception)', look: 'the Driver Station log\'s messages at that moment: a stack trace; the last lines of the console in AdvantageScope' },
    { id: 'switched-off', cause: 'Someone switched the robot off without disabling it first', look: 'ask the drive team; disable before switching off' },
    { id: 'slow-sag', cause: 'The battery sagged until the roboRIO reset', look: 'Power tab: battery voltage in the seconds before the log ends' },
    { id: 'cut-short', cause: 'Only the log file was cut short (copied off the robot while it was still writing)', look: 'the robot\'s log folder: is there a later log from this run?' },
  ],
  nextStep: 'Ask whether anyone deployed code or switched the robot off at that moment; if nobody did, tug-test the roboRIO\'s power wiring with the robot on.',
  incident: '2026-02-21 practice: two logs end while driving at 12.4–12.5 V, no exception in the console (failure-detection-measurements §6)',

  check(match) {
    const enabled = match.signal('enabled')
    if (enabled.at(match.logEnd) < 0.5) return
    if ((match.signalIfLogged('fmsAttached')?.at(match.logEnd) ?? 0) > 0.5) return // on the field: restart-mid-match

    const enabledFor = match.logEnd - (enabled.turnsOn().at(-1) ?? match.logStart)
    const lowestVolts = match.signalIfLogged('batteryVoltage')?.lowest(match.before(match.logEnd, 2)).value ?? NaN
    const crashAt = lastCrashMessage(match)
    const next = nextRun(match)
    const shas = [match.build.sha, next?.view.build.sha ?? '']
    const newCommit = shas.every((sha) => sha !== '') && shas[0] !== shas[1]

    const likely: string[] = []
    const ruledOut: Record<string, string> = {}
    if (crashAt !== null) likely.push('crash')
    if (newCommit) likely.push('redeploy')
    if (lowestVolts >= SLOW_SAG_VOLTS) ruledOut['slow-sag'] = `the battery read ${volts(lowestVolts)} or more in the last 2 s`
    if (next) ruledOut['cut-short'] = 'the next program\'s log is loaded, so the program did stop'

    const restart = next ? `; the next program started ${secs(next.secondsLater)} later` : ''
    const crashWords = crashAt === null ? 'none' : `at robot time ${crashAt.toFixed(1)} s`
    const nextLog = next ? `${next.view.raw.fileName}, ${commitWords(match, next.view, newCommit)}` : 'none loaded that started within 5 min'
    return {
      message: `Robot program stopped ${match.whenAt(match.logEnd - 0.001)} while enabled: the log ends ${secs(enabledFor)} `
        + `into an enable${restart}`,
      at: match.logEnd,
      likely,
      ruledOut,
      evidence: {
        'enabled for, when the log ends (s)': round(enabledFor, 1),
        'lowest battery voltage in the last 2 s (V)': Number.isFinite(lowestVolts) ? round(lowestVolts) : undefined,
        'crash message in the last 5 s of the console': crashWords,
        'next program started (s later)': next ? round(next.secondsLater, 1) : undefined,
        'next log': nextLog,
      },
      nextStep: newCommit
        ? 'The next program ran a different commit, so someone most likely deployed while the robot was enabled: '
          + 'disable it before deploying.'
        : undefined,
      plot: { signals: ['batteryVoltage'], unit: 'V', from: match.logEnd - 10, to: match.logEnd },
    }
  },
})

/** When the console last said the code crashed, if that was in the last CRASH_SECONDS of the log (null if not). */
function lastCrashMessage(match: MatchView): number | null {
  if (!match.has('console')) return null
  const { t, v } = match.text('console').series
  for (let i = t.length - 1; i >= 0 && t[i] >= match.logEnd - CRASH_SECONDS; i--) if (CRASH_TEXT.test(v[i])) return t[i]
  return null
}

/**
 * The next program run on this robot, if its log is loaded: the first log of the same robot code whose program
 * started (robot time 0, on the wall clock) within NEXT_RUN_SECONDS after this log ended.
 */
function nextRun(match: MatchView): { view: MatchView; secondsLater: number } | null {
  const end = match.wallClock(match.logEnd)
  if (end === null) return null
  const runs = match.otherLogs()
    .filter((o) => o.profile.codebase === match.profile.codebase)
    .map((view) => ({ view, secondsLater: (view.wallClock(0) ?? NaN) - end }))
    .filter((r) => r.secondsLater >= 0 && r.secondsLater < NEXT_RUN_SECONDS)
    .sort((a, b) => a.secondsLater - b.secondsLater)
  return runs[0] ?? null
}

/** The next log's commit in words: a different one, the same one, or one that can't be compared. */
function commitWords(match: MatchView, next: MatchView, newCommit: boolean): string {
  const sha = next.build.sha.slice(0, 7) || 'not logged'
  if (newCommit) return `commit ${sha} (a different commit)`
  if (!match.build.sha || !next.build.sha) return `commit ${sha} (can't compare: a commit isn't logged)`
  if (/uncommitted/i.test(next.build.dirty)) return `commit ${sha} with uncommitted changes (a redeploy can't be ruled out)`
  return `commit ${sha} (same commit)`
}
