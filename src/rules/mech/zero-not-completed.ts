/**
 * mech/zero-not-completed — did a mechanism move before its zero completed?
 *
 * Checks: for each mechanism in the profile's `zeroing` list, the first time it moved while enabled (more than
 * `moveDegrees` from where it was at enable, AWAY from the stop the zero drives into: travel toward the stop is the
 * zeroing itself) against the first console message saying the zero completed.
 * Moving first means every angle it was sent to was in the wrong frame. Also reports the position jump when the
 * zero finally lands (the frame correcting itself).
 * Why: CalGames 2026 Q13/Q21: the hood's on-enable zero was cancelled 0.2 s into auto, so "10°" was 8° above the
 * hard stop all auto, and the hood hit the trench in Q13. Fixed in 8ba92cb (zero at boot); P0 must stay quiet.
 * When it fires: make the zero complete before anything can command the mechanism (zero at boot, or sequence it
 * ahead of the first auto command), and set the "zeroed" flag when it does.
 */
import { has, num, values, type Match } from '../../match/match.ts'
import { valueAt } from '../../match/series.ts'
import { when } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

export const zeroNotCompleted: Rule = {
  id: 'mech/zero-not-completed',
  title: 'Mechanism moved before its zero completed',
  audience: ['software'],
  fix: 'Make the zero finish before any command can move the mechanism: zero at boot, or put the zero command ahead of the first auto command; set the zeroed flag when it completes.',
  incident: 'CalGames 2026 Q13/Q21: hood zero cancelled 0.2 s into auto; fixed by 8ba92cb (2026-10-17-calgames-q13-log-analysis.md §1)',
  needs: (m: Match) => [m.profile.signals.console, ...m.profile.zeroing.map((z) => z.position)],
  run(m: Match): Finding[] {
    const consoleLines = values<string>(m, m.profile.signals.console)!
    const out: Finding[] = []
    for (const z of m.profile.zeroing) {
      if (!has(m, z.position)) continue
      const pos = num(m, z.position)!
      const doneIndex = consoleLines.v.findIndex((line) => z.doneMessage.test(line))
      const doneAt = doneIndex >= 0 ? consoleLines.t[doneIndex] : Infinity
      let movedAt: number | null = null
      for (const iv of m.enabled) {
        const startDeg = valueAt(pos, iv.start) * z.positionToDegrees
        for (let i = 0; i < pos.t.length && movedAt === null; i++) {
          if (pos.t[i] < iv.start || pos.t[i] >= iv.end) continue
          const away = (pos.v[i] * z.positionToDegrees - startDeg) * (z.zeroDirection === 'down' ? 1 : -1)
          if (away > z.moveDegrees) movedAt = pos.t[i]
        }
        if (movedAt !== null) break
      }
      if (movedAt === null || movedAt >= doneAt) continue
      const jump = Number.isFinite(doneAt)
        ? (valueAt(pos, doneAt + 0.1) - valueAt(pos, doneAt - 0.1)) * z.positionToDegrees
        : NaN
      out.push({
        rule: this.id,
        severity: 'error',
        title: `${z.mechanism} moved at ${when(m, movedAt)} before its zero completed${Number.isFinite(doneAt) ? ` (at ${doneAt.toFixed(1)} s)` : ' (never)'}`,
        time: movedAt,
        evidence: {
          'first move while enabled (s)': +movedAt.toFixed(2),
          'zero completed (s)': Number.isFinite(doneAt) ? +doneAt.toFixed(2) : 'never',
          'seconds moving in the wrong frame': Number.isFinite(doneAt) ? +(doneAt - movedAt).toFixed(1) : 'whole match',
          'position jump when the zero landed (°)': Number.isFinite(jump) ? +jump.toFixed(1) : 'n/a',
        },
        plot: {
          from: movedAt - 2, to: movedAt + 6, unit: '°',
          lines: [{ label: `${z.mechanism} position`, key: z.position, scale: z.positionToDegrees }],
          markers: [{ t: movedAt, label: 'moved' }],
        },
      })
    }
    return out
  },
}
