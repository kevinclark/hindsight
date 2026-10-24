/**
 * Was an auto chosen when the match started?
 *
 * Checks: the log's first enable is autonomous with the field (FMS) attached, and the auto chooser reads "None" at
 * that moment.
 * Why: the chooser starts at "None" every time the robot code starts, and the drive team picks the auto by hand after
 * the field connects (three 2026 matches: 1.0–6.1 s after the FMS attached). Forget it, and the robot sits
 * still for the whole auto.
 *
 * Only the first enable, and only on the field (measured on 141 local logs, 2026-10-19): off the field, 74 of the 83
 * first enables with a chooser read "None", and that is normal in the pit. On the field, a log whose first enable is
 * teleop is a restarted piece of a match, which loop/restart-mid-match reports. Amber until it has caught a real match.
 */
import { rule, round } from '../rule.ts'
import { WPILIB_AUTO_CHOOSER } from '../sources.ts'
import type { MatchView, Window } from '../view.ts'

const NO_AUTO = /^none$/i

export default rule({
  id: 'auto/none-at-enable',
  title: 'No auto chosen at the start of the match',
  severity: 'warning',
  judges: 'performance',
  who: ['drive'],
  meaning: 'The auto chooser still said "None" when the match started, so the robot ran no auto.',
  causes: [
    { id: 'forgot', cause: 'Nobody picked the auto on the dashboard after the field connected', look: 'the drive team\'s pre-match checklist; the auto chooser key in AdvantageScope: did it ever change before auto?' },
    { id: 'late', cause: 'The auto was picked, but only after the match had started', look: 'the evidence below: when the chooser changed' },
    { id: 'on-purpose', cause: 'The team chose to run no auto (some practice matches)', look: 'ask the drive team' },
  ],
  nextStep: 'Pick the auto on the dashboard after the field connects, and have a second person read it back before every match.',
  incident: 'The chooser starts at "None" on every boot; a 2025 practice match ran its whole auto on "None" and the robot did not move',
  sources: [
    { ...WPILIB_AUTO_CHOOSER, says: 'The option set with setDefaultOption is the one selected when the dashboard starts; a person picks the auto before autonomous begins and the code reads it in autonomousInit.' },
  ],
  thresholds: [
    { name: 'which enable is checked', value: 'the first enable, on the field', basis: 'measured', how: 'On 141 local logs (2026-10-19), 74 of the 83 first enables off the field with a chooser read "None", which is normal in the pit; on the field the first enable is the match.' },
  ],

  check(match) {
    const first = match.enabled[0]
    if (!first) return match.couldNotCheck('the robot was never enabled')
    if (!match.has('fmsAttached')) return match.couldNotCheck('the log has no FMS-attached flag')
    const onField = match.signal('fmsAttached').at(first.start) > 0.5
    const autonomous = match.auto[0]?.start === first.start
    if (!onField || !autonomous) return match.couldNotCheck('the first enable was not auto on the field')

    const chooser = match.text('autoChoice')
    const chosen = chooser.at(first.start)
    if (chosen === '') {
      match.couldNotCheck('the auto chooser was first logged after auto started')
      return
    }
    if (!NO_AUTO.test(chosen)) return

    const pickedLater = firstPickAfter(chooser.series, first.start)
    const moved = distanceDriven(match, match.auto.slice(0, 1))

    return {
      message: `No auto chosen: the auto chooser read "${chosen}" when auto started at ${match.when(first.start)}`,
      at: first.start,
      likely: pickedLater === null ? ['forgot'] : ['late'],
      evidence: {
        'auto chooser when auto started': chosen,
        'auto chooser picked later (robot time, s)': pickedLater === null ? undefined : round(pickedLater),
        'auto chooser changes in this log': chooser.series.v.length - 1,
        'distance the robot drove in auto (m, from odometry)': moved === null ? undefined : round(moved),
      },
    }
  },
})

/** When the chooser was first set to a real auto after time t, or null if it never was. */
function firstPickAfter(series: { t: Float64Array; v: string[] }, t: number): number | null {
  const i = series.v.findIndex((v, k) => series.t[k] > t && !NO_AUTO.test(v))
  return i < 0 ? null : series.t[i]
}

/** How far the odometry pose travelled during the window (m), or null when the log has no odometry. */
function distanceDriven(match: MatchView, window: Window): number | null {
  if (!match.has('odometryPose')) return null
  const pose = match.pose('odometryPose')
  let total = 0
  for (let i = 1; i < pose.series.t.length; i++) {
    const t = pose.series.t[i]
    if (!window.some((iv) => t > iv.start && t <= iv.end)) continue
    const from = pose.series.v[i - 1]
    const to = pose.series.v[i]
    total += Math.hypot(to.x - from.x, to.y - from.y)
  }
  return total
}
