/**
 * Did a mechanism move before its zero completed?
 *
 * Checks: for each mechanism in the profile's `zeroing` list, the first time it moved while enabled (more than a
 * few degrees AWAY from the stop the zero drives into; travel toward the stop is the zeroing itself), against the
 * first console message saying the zero completed. Moving first means every angle it was sent to was wrong, unless the
 * zero barely changed the position when it landed (less than moveDegrees): then the angles were already right, e.g.
 * the mechanism was seeded from an absolute encoder and this zero was a re-check. A log with no zero at all that starts
 * at the angle the zero sets (the profile's stopDegrees) began already zeroed: the motor controller kept the zero
 * through a code restart. A code restart after an unzeroed run left it at that angle would start there too; the log
 * can't tell the two apart.
 * Why: Two 2026 matches: the hood's zero was cancelled 0.2 s into auto, so "10°" was 8° above the hard stop
 * all auto, and the hood hit the trench in log A. Fixed in 8ba92cb (zero at boot); log C must stay quiet.
 */
import { rule, round, secs } from '../rule.ts'
import { CTRE_REMOTE_SENSORS, CTRE_TUNER_ELEVATOR } from '../sources.ts'
import type { MatchView, MechanismView, Signal } from '../view.ts'

export default rule({
  id: 'mech/zero-not-completed',
  title: 'Mechanism moved before its zero completed',
  severity: 'error',
  who: ['software'],
  meaning: 'A mechanism moved before its zero (finding its hard stop) finished, so every angle it was sent to was measured from the wrong starting point. It went to the wrong place.',
  causes: [
    { id: 'zero-cancelled', cause: 'The zero command was cancelled or interrupted by another command (often the first auto command)', look: 'the code file for the mechanism\'s zero command: what requires the same subsystem, and what is scheduled when auto starts' },
    { id: 'zero-late', cause: 'The zero only runs after the robot is enabled, and something else moves the mechanism first', look: 'the code that starts the zero: can it run at boot or in disabled, before any command?' },
    { id: 'zero-never-ran', cause: 'The zero was never started, or its \'done\' message is never printed', look: 'the code: is the zero command scheduled at all? The console log for the zero-complete message' },
  ],
  nextStep: 'Make the zero finish before any command can move the mechanism: zero at boot, or put the zero command ahead of the first auto command; set the zeroed flag when it completes.',
  incident: 'Two 2026 matches: hood zero cancelled 0.2 s into auto; fixed by 8ba92cb',
  sources: [
    { ...CTRE_TUNER_ELEVATOR, says: 'The elevator subsystem that Tuner X generates includes a current-based homing routine to zero the elevator.' },
    { ...CTRE_REMOTE_SENSORS, says: 'SyncCANcoder syncs the motor rotor to a remote CANcoder and then uses the rotor for control; it reports when the two positions differ significantly.' },
  ],
  thresholds: [
    { name: 'movement that counts as moving', value: 'the mechanism\'s moveDegrees, a few degrees', basis: 'judgment', how: 'Set per mechanism in the robot profile.' },
  ],
  forEach: 'mechanism',

  check(mechanism, match) {
    const position = mechanism.position()
    const doneAt = mechanism.zeroDoneAt ?? Infinity
    if (!Number.isFinite(doneAt) && startsZeroed(mechanism, position)) return
    const away = mechanism.zeroDirection === 'down' ? 1 : -1 // which way is "away from the stop"
    let movedAt: number | null = null
    for (const period of match.enabled) {
      if (period.start >= doneAt) break
      const startAngle = position.at(period.start)
      const moved = position.episodes((deg) => (deg - startAngle) * away > mechanism.moveDegrees, { during: [period] })
      if (moved.length) { movedAt = moved[0].start; break }
    }
    // Never moved while enabled, before or after the zero: the match never put the zero to the test.
    if (movedAt === null && !movedWhileEnabled(mechanism, position, match)) return match.couldNotCheck('it never moved while enabled')
    if (movedAt === null || movedAt >= doneAt) return
    const plot = { signals: [position], unit: '°', from: movedAt - 2, to: movedAt + 6, marks: [movedAt] }

    // No zero by the end: every angle in the match was measured from the wrong starting point.
    const zeroed = Number.isFinite(doneAt)
    const secondsLater = doneAt - movedAt
    const jump = zeroed ? position.at(doneAt + 0.1) - position.at(doneAt - 0.1) : NaN
    // Less the travel it was already making (the 0.2 s before), so motion at that moment isn't read as a jump.
    const travelBefore = zeroed ? position.at(doneAt - 0.1) - position.at(doneAt - 0.3) : NaN
    const drift = Number.isFinite(travelBefore) ? travelBefore : 0 // a zero right at the start of the log has no travel before it
    if (zeroed && Math.abs(jump - drift) < mechanism.moveDegrees) return

    return {
      // The log can't tell a cancelled zero from a late one, so only rule out "never ran" when it did finish.
      ruledOut: zeroed ? { 'zero-never-ran': `the zero did complete, ${secs(secondsLater)} after the first move` } : undefined,
      message: `${mechanism.name} moved ${match.whenAt(movedAt)} before its zero completed${zeroed ? `, ${secs(secondsLater)} later` : ' (it never did)'}`,
      at: movedAt,
      evidence: {
        'first move while enabled (robot time, s)': round(movedAt),
        'zero completed (robot time, s)': zeroed ? round(doneAt) : 'never',
        'seconds moving in the wrong frame': zeroed ? round(secondsLater, 1) : 'whole match',
        'position jump when the zero landed (°)': zeroed ? round(jump, 1) : 'n/a',
        'travel in the 0.2 s before the zero (°)': zeroed ? round(drift, 1) : 'n/a',
      },
      plot,
    }
  },
})

/** Did the mechanism move more than `moveDegrees` (either way) in any enabled stretch, before or after its zero? */
function movedWhileEnabled(mechanism: MechanismView, position: Signal, match: MatchView): boolean {
  return match.enabled.some((period) => {
    const startAngle = position.at(period.start)
    return position.episodes((deg) => Math.abs(deg - startAngle) > mechanism.moveDegrees, { during: [period] }).length > 0
  })
}

/** Does the log start at the angle the zero sets? (2026-02-21: 15 logs started at 23.8°, the zero kept.) */
function startsZeroed(mechanism: MechanismView, position: Signal): boolean {
  const stop = mechanism.stopDegrees
  return typeof stop === 'number' && Math.abs(position.first() - stop) < mechanism.moveDegrees
}
