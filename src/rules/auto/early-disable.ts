/**
 * auto/early-disable — was the robot disabled during auto with time left, on the field?
 *
 * Checks: under FMS, an auto period that ends more than 1 s before the auto length while the DS is still attached.
 * That is a deliberate disable (an A-stop or the drive team), not a comms loss.
 * Why: CalGames 2026 Q13: the robot wedged under the trench and was disabled with 7.3 s of auto left.
 * When it fires: find out why from the drive team, then look at the moments before (collision/tilt, mech/*).
 */
import { matchTimeLeft, num, type Match } from '../../match/match.ts'
import { valueAt } from '../../match/series.ts'
import type { Finding, Rule } from '../types.ts'

export const earlyDisable: Rule = {
  id: 'auto/early-disable',
  title: 'Disabled during auto',
  audience: ['software', 'drive'],
  fix: 'Ask the drive team why (A-stop?), then check what happened just before: collision/tilt, a mechanism out of position, a stuck path.',
  incident: 'CalGames 2026 Q13: disabled at 282.7 s with 7.3 s of auto left after the hood hit the trench (2026-10-17-calgames-q13-log-analysis.md §1)',
  needs: (m: Match) => [m.profile.signals.enabled, m.profile.signals.autonomous, m.profile.signals.fmsAttached],
  run(m: Match): Finding[] {
    if (!m.fms || m.matchStart === null) return []
    const autoStart = m.matchStart
    const attached = num(m, m.profile.signals.dsAttached)
    const out: Finding[] = []
    for (const iv of m.auto.filter((x) => x.start >= autoStart && x.start < autoStart + m.profile.game.autoSeconds)) {
      const left = matchTimeLeft(m, iv.end).secondsLeft
      const dsStillThere = !attached || valueAt(attached, iv.end + 0.05) > 0.5
      if (left <= 1 || !dsStillThere) continue
      out.push({
        rule: this.id,
        severity: 'error',
        title: `Disabled in auto at ${iv.end.toFixed(1)} s with ${left.toFixed(1)} s of auto left`,
        time: iv.end,
        evidence: { 'auto enabled (s)': +autoStart.toFixed(2), 'disabled (s)': +iv.end.toFixed(2), 'auto time left (s)': +left.toFixed(1), 'DS still attached': 'yes' },
        plot: {
          from: autoStart - 1, to: Math.min(iv.end + 5, autoStart + m.profile.game.autoSeconds + 2), unit: '°',
          lines: [
            { label: 'Gyro pitch', key: m.profile.signals.gyroPitch, scale: 180 / Math.PI },
            { label: 'Gyro roll', key: m.profile.signals.gyroRoll, scale: 180 / Math.PI },
          ],
          markers: [{ t: iv.end, label: 'disabled' }],
        },
      })
    }
    return out
  },
}
