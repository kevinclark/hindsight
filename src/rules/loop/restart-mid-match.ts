/**
 * Did the robot program stop or restart during a match on the field?
 *
 * Checks: a log that ends while the robot is enabled on the field (the program stopped), or starts already enabled on
 * the field (it came back mid-match). A normal field log starts before the match and runs past it. With the match's
 * other logs loaded too, it says how long there was no program (the robot's wall clock), and which controllers
 * came back.
 * Why: MTTD 2025 Q28: the program restarted twice in teleop, so the match is three logs ("the logs seem corrupted")
 * and there was no log (program down or starting up) for 13 s and 50 s of the last ~84 s. After the second restart the driver's
 * controller (port 0) was missing. In 81 logs (MTTD 2025 and CalGames 2026) only Q28's start or end enabled on the field.
 */
import { rule, round } from '../rule.ts'
import type { MatchView } from '../view.ts'

const SAME_MATCH_SECONDS = 30 * 60 // pieces of one match start within 30 min (the session view's rule, session.ts)
const SLOW_SAG_VOLTS = 9 // above this in the last 2 s, the battery wasn't sagging toward a roboRIO reset (assumed)

/** Is the robot enabled with the field attached at time t (at the start: each signal's first record, if later)? */
const live = (m: MatchView, t: number) => ['enabled', 'fmsAttached'].every((name) => {
  const s = m.signal(name)
  return s.at(Math.max(t, s.series.t[0] ?? t)) > 0.5
})
/** Did this piece start already enabled on the field (the program came back mid-match)? */
const startsLive = (m: MatchView) => live(m, m.logStart)

/** Joystick ports with a controller plugged in at some point in the 10 s from t (button count above 0). */
function controllers(m: MatchView, t: number): number[] {
  return m.profile.signals.joystickButtonCounts.flatMap((key, port) => {
    if (!m.has(key)) return []
    const s = m.signal(key) // logged only when it changes: the value held at t counts too
    return Math.max(s.at(t) || 0, s.highest(m.between(t, t + 10)).value || 0) > 0 ? [port] : []
  })
}
const ports = (list: number[]) => (list.length ? list.map((p) => `port ${p}`).join(', ') : 'none')

/** The loaded logs of this match (this one included), in order, with their wall-clock extent. */
function piecesOf(match: MatchView) {
  const all = [match, ...match.otherLogs().filter((o) => o.onField && o.event === match.event && o.matchLabel === match.matchLabel)]
    .map((v) => ({ v, start: v.wallClock(v.logStart), end: v.wallClock(v.logEnd) }))
    .filter((p): p is { v: MatchView; start: number; end: number } => p.start !== null && p.end !== null)
  const me = all.find((p) => p.v === match)
  return me && match.matchLabel ? all.filter((p) => Math.abs(p.start - me.start) < SAME_MATCH_SECONDS).sort((a, b) => a.start - b.start) : []
}

export default rule({
  id: 'loop/restart-mid-match',
  title: 'Robot program restarted mid-match',
  severity: 'error',
  who: ['software', 'pit'],
  meaning: 'The robot program stopped during the match, so the robot did nothing until it started again (if it did). One match is then split over several logs.',
  causes: [
    { id: 'crash', cause: 'The robot code crashed (an uncaught exception) and the roboRIO restarted it', look: 'the Driver Station log\'s messages for this match: a stack trace just before the stop; the code that runs at that moment' },
    { id: 'power', cause: 'The roboRIO lost power for an instant (its power wires or connector, the battery lead, the main breaker)', look: 'tug-test the roboRIO power connector and wires, the battery connector and the main breaker; does the DS log show the robot vanish (power) or a code restart?' },
    { id: 'slow-sag', cause: 'The battery sagged until the roboRIO reset', look: 'Power tab: battery voltage in the seconds before the log ends; the power/brownout finding' },
    { id: 'cut-short', cause: 'Only the log file was cut short (copied while the robot was still writing it)', look: 'the robot\'s log folder: is there a later log from this match?' },
  ],
  nextStep: 'Read the Driver Station log\'s messages for this match (a stack trace means the code crashed), and load the match\'s other robot logs to see how long the robot had no program.',
  incident: 'MTTD 2025 Q28: two restarts in teleop, three logs, no program for ~63 s of the last ~84 s (mttd-2025-context.md §1)',

  check(match) {
    if (!match.onField) return
    const startsMid = startsLive(match), endsMid = live(match, match.logEnd)
    if (!startsMid && !endsMid) return
    const pieces = piecesOf(match)
    const i = pieces.findIndex((p) => p.v === match)
    // Neighbours count only as the other side of a restart: the previous one ended live and the next one starts live
    // (a replay of the same match label is a different match).
    const before = startsMid && i > 0 && live(pieces[i - 1].v, pieces[i - 1].v.logEnd) ? pieces[i - 1] : null
    const after = endsMid && i >= 0 && i < pieces.length - 1 && startsLive(pieces[i + 1].v) ? pieces[i + 1] : null
    // Each gap between a log that ended enabled and the next one that started enabled: no program, or one starting up.
    const gaps = pieces.slice(1).flatMap((p, k) => (live(pieces[k].v, pieces[k].v.logEnd) && startsLive(p.v) ? [p.start - pieces[k].end] : []))
    const now = startsMid ? controllers(match, match.logStart) : []
    const lost = before ? controllers(before.v, before.v.logEnd - 10).filter((p) => !now.includes(p)) : []
    const clock = match.has('matchTimeLeft') ? match.signal('matchTimeLeft').series : null
    // The first DS record after a restart can be stale (Q28: 80 then 68 two seconds later; 16 then 0): use the next.
    const clockAfterStart = clock && clock.t.length > 1 && clock.t[1] - match.logStart < 5 ? clock.v[1] : NaN
    // The lowest battery voltage in the last 2 s, counting the value held from before them and the very last record.
    const battery = endsMid && match.has('batteryVoltage') ? match.signal('batteryVoltage') : null
    const lows = battery ? [battery.at(match.logEnd - 2), battery.lowest(match.before(match.logEnd, 2)).value, battery.at(match.logEnd)].filter(Number.isFinite) : []
    const volts = lows.length ? Math.min(...lows) : NaN
    const what = startsMid && endsMid ? 'restarted mid-match and stopped again: this log starts and ends while enabled on the field'
      : startsMid ? 'restarted mid-match: this log starts already enabled on the field'
      : `stopped at ${match.when(match.logEnd - 0.001)}: the log ends while enabled on the field`
    // Wall-clock gaps are good to ~2 s: the robot clock offset scatters by that much between logs (MTTD Q28).
    const downBefore = before ? `, ${(match.wallClock(match.logStart)! - before.end).toFixed(0)} s after the previous log stopped` : ''
    const downAfter = after ? `; the next log starts ${(after.start - match.wallClock(match.logEnd)!).toFixed(0)} s later` : ''
    return {
      message: `Robot program ${what}${downBefore}${downAfter}${lost.length ? `; no controller on ${ports(lost)} after the restart` : ''}`,
      // A log that starts mid-match counts match time from its own first enable, so its "when" would mislead.
      at: startsMid ? null : match.logEnd,
      ruledOut: {
        ...(volts >= SLOW_SAG_VOLTS ? { 'slow-sag': `the battery read ${volts.toFixed(2)} V or more in the last 2 s` } : {}),
        ...(!endsMid || after ? { 'cut-short': endsMid ? 'the program\'s next log from this match is loaded' : 'this log ends normally' } : {}),
      },
      nextStep: pieces.length > 1 ? 'Read the Driver Station log\'s messages for this match: a stack trace means the code crashed; none points at power (tug-test the roboRIO\'s power wiring).' : undefined,
      measured: gaps.length ? [{ label: 'between logs (program down or starting up)', value: round(gaps.reduce((a, b) => a + b, 0), 1), unit: 's' }] : undefined,
      evidence: {
        'this log starts': startsMid ? 'already enabled on the field' : 'normally (before the match)',
        'this log ends': endsMid ? 'while enabled on the field' : 'normally',
        ...(endsMid && clock ? { 'left on the match clock when this log ends (s)': match.signal('matchTimeLeft').at(match.logEnd) } : {}),
        ...(Number.isFinite(clockAfterStart) ? { 'left on the match clock just after this log starts (s)': clockAfterStart } : {}),
        ...(Number.isFinite(volts) ? { 'lowest battery voltage in the last 2 s of this log (V)': round(volts) } : {}),
        'logs of this match loaded': pieces.length > 1 ? `${pieces.length} (this is number ${i + 1})` : 'only this one',
        ...(gaps.length ? { 'between logs, program down or starting up (s, ±2)': gaps.map((g) => g.toFixed(1)).join(', ') } : {}),
        ...(startsMid ? { 'controllers in the first 10 s of this log': ports(now) } : {}),
        ...(before ? { 'controllers before the stop': ports(controllers(before.v, before.v.logEnd - 10)) } : {}),
      },
      plot: endsMid ? { signals: ['batteryVoltage'], unit: 'V' } : undefined,
    }
  },
})
