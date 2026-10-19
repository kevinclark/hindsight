/**
 * Did a mechanism move before its zero completed?
 *
 * Checks: for each mechanism in the profile's `zeroing` list, the first time it moved while enabled (more than a
 * few degrees AWAY from the stop the zero drives into; travel toward the stop is the zeroing itself), against the
 * first console message saying the zero completed. Moving first means every angle it was sent to was wrong, unless the
 * zero barely changed the position when it landed (less than moveDegrees): then the angles were already right, e.g.
 * the mechanism was seeded from an absolute encoder and this zero was a re-check.
 * Why: CalGames 2026 Q13/Q21: the hood's zero was cancelled 0.2 s into auto, so "10°" was 8° above the hard stop
 * all auto, and the hood hit the trench in Q13. Fixed in 8ba92cb (zero at boot); P0 must stay quiet.
 */
import { rule, round } from '../rule.ts'

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
  incident: 'CalGames 2026 Q13/Q21: hood zero cancelled 0.2 s into auto; fixed by 8ba92cb (2026-10-17-calgames-q13-log-analysis.md §1)',
  forEach: 'mechanism',

  check(mechanism, match) {
    const position = mechanism.position()
    const doneAt = mechanism.zeroDoneAt ?? Infinity
    const away = mechanism.zeroDirection === 'down' ? 1 : -1 // which way is "away from the stop"
    let movedAt: number | null = null
    for (const period of match.enabled) {
      if (period.start >= doneAt) break
      const startAngle = position.at(period.start)
      const moved = position.episodes((deg) => (deg - startAngle) * away > mechanism.moveDegrees, { during: [period] })
      if (moved.length) { movedAt = moved[0].start; break }
    }
    if (movedAt === null || movedAt >= doneAt) return
    const zeroed = Number.isFinite(doneAt)
    const jump = zeroed ? position.at(doneAt + 0.1) - position.at(doneAt - 0.1) : NaN
    // Less the travel it was already making (the 0.2 s before), so motion at that moment isn't read as a jump.
    const before = zeroed ? position.at(doneAt - 0.1) - position.at(doneAt - 0.3) : 0
    const drift = Number.isFinite(before) ? before : 0 // a zero right at the start of the log has no travel before it
    if (zeroed && Math.abs(jump - drift) < mechanism.moveDegrees) return
    // The log can't tell a cancelled zero from a late one, so only rule out "never ran" when it did finish.
    return {
      ruledOut: zeroed ? { 'zero-never-ran': `the zero did complete, ${(doneAt - movedAt).toFixed(1)} s after the first move` } : undefined,
      message: `${mechanism.name} moved at ${match.when(movedAt)} before its zero completed${zeroed ? `, ${(doneAt - movedAt).toFixed(1)} s later` : ' (it never did)'}`,
      at: movedAt,
      evidence: {
        'first move while enabled (robot time, s)': round(movedAt),
        'zero completed (robot time, s)': zeroed ? round(doneAt) : 'never',
        'seconds moving in the wrong frame': zeroed ? round(doneAt - movedAt, 1) : 'whole match',
        'position jump when the zero landed (°)': zeroed ? round(jump, 1) : 'n/a',
        'travel in the 0.2 s before the zero (°)': zeroed ? round(drift, 1) : 'n/a',
      },
      plot: [position], plotUnit: '°', plotFrom: movedAt - 2, plotTo: movedAt + 6, plotMarks: [movedAt],
    }
  },
})
