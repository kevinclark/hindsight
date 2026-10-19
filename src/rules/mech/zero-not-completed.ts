/**
 * Did a mechanism move before its zero completed?
 *
 * Checks: for each mechanism in the profile's `zeroing` list, the first time it moved while enabled (more than a
 * few degrees AWAY from the stop the zero drives into; travel toward the stop is the zeroing itself), against the
 * first console message saying the zero completed. Moving first means every angle it was sent to was wrong.
 * Why: CalGames 2026 Q13/Q21: the hood's zero was cancelled 0.2 s into auto, so "10°" was 8° above the hard stop
 * all auto, and the hood hit the trench in Q13. Fixed in 8ba92cb (zero at boot); P0 must stay quiet.
 */
import { rule, round } from '../rule.ts'

export default rule({
  id: 'mech/zero-not-completed',
  title: 'Mechanism moved before its zero completed',
  severity: 'error',
  who: ['software'],
  fix: 'Make the zero finish before any command can move the mechanism: zero at boot, or put the zero command ahead of the first auto command; set the zeroed flag when it completes.',
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
    return {
      message: `${mechanism.name} moved at ${match.when(movedAt)} before its zero completed${zeroed ? ` (at ${doneAt.toFixed(1)} s)` : ' (it never did)'}`,
      at: movedAt,
      evidence: {
        'first move while enabled (s)': round(movedAt),
        'zero completed (s)': zeroed ? round(doneAt) : 'never',
        'seconds moving in the wrong frame': zeroed ? round(doneAt - movedAt, 1) : 'whole match',
        'position jump when the zero landed (°)': zeroed ? round(position.at(doneAt + 0.1) - position.at(doneAt - 0.1), 1) : 'n/a',
      },
      plot: [position], plotUnit: '°', plotFrom: movedAt - 2, plotTo: movedAt + 6, plotMarks: [movedAt],
    }
  },
})
