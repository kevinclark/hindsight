/**
 * collision/tilt — did the robot tip or wedge?
 *
 * Checks: gyro pitch or roll beyond ±15° for longer than 0.3 s while enabled. Red in auto, amber in teleop.
 * Bump crossings tilt the robot past 15° too, but for 0.2 s or less (every CalGames log has several); a wedge
 * or a climb onto something lasts longer.
 * Why: CalGames 2026 Q13: the hood hit the trench bar in auto, pitch −23° for 1.0 s, and the robot was disabled.
 * When it fires: watch the match video at that time; check what was up (hood, intake) and where the robot was.
 * Not yet checked: field bump and trench zones (the game pack, phase 2).
 */
import { has, num, phaseAt, type Match } from '../../match/match.ts'
import { intervalsWhere, peakIn, when } from '../helpers.ts'
import type { Finding, Rule } from '../types.ts'

const LIMIT_DEG = 15
const MIN_SECONDS = 0.3

export const tilt: Rule = {
  id: 'collision/tilt',
  title: 'Robot tilted or wedged',
  fix: 'Watch the match video at this time. If it was a field element, check what was raised (hood, intake) and add a guard in code near that element.',
  incident: 'CalGames 2026 Q13: −23° pitch for 1.0 s at the trench in auto (2026-10-17-calgames-q13-log-analysis.md §1)',
  needs: (m: Match) => [m.profile.signals.gyroPitch, m.profile.signals.gyroRoll],
  run(m: Match): Finding[] {
    const out: Finding[] = []
    const toDeg = 180 / Math.PI
    for (const [axis, key] of [['Pitch', m.profile.signals.gyroPitch], ['Roll', m.profile.signals.gyroRoll]] as const) {
      if (!has(m, key)) continue
      const s = num(m, key)!
      const events = intervalsWhere(s, (r) => Math.abs(r * toDeg) > LIMIT_DEG, m.enabled, m.logEnd)
        .filter((iv) => iv.end - iv.start > MIN_SECONDS)
      for (const iv of events) {
        const abs = { ...s, v: s.v.map((r) => Math.abs(r * toDeg)) }
        const peak = peakIn(abs, iv.start, iv.end)
        const signed = s.v[Array.from(s.t).indexOf(peak.t)] * toDeg
        const phase = phaseAt(m, iv.start)
        out.push({
          rule: this.id,
          severity: phase === 'auto' ? 'error' : 'warning',
          title: `${axis} ${signed.toFixed(0)}° for ${(iv.end - iv.start).toFixed(1)} s at ${when(m, iv.start)}`,
          time: iv.start,
          evidence: { axis, 'peak (°)': +signed.toFixed(1), 'seconds beyond ±15°': +(iv.end - iv.start).toFixed(2), phase },
          plot: {
            from: iv.start - 3, to: iv.end + 3, unit: '°',
            lines: [
              { label: 'Pitch', key: m.profile.signals.gyroPitch, scale: toDeg },
              { label: 'Roll', key: m.profile.signals.gyroRoll, scale: toDeg },
            ],
            threshold: { value: -LIMIT_DEG, label: '−15°' },
          },
        })
      }
    }
    return out
  },
}
