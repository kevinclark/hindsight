/**
 * battery/gauge-capacity — does the fuel gauge say this battery has lost capacity?
 *
 * Checks: BatteryGauge/EffectiveCapacityAh (only while BatteryGauge/Valid is true) against 12 Ah.
 * Why: CalGames 2026 P0's battery collapsed after ~3.5 Ah. The gauges learn each battery's capacity; one in-season
 * snapshot showed 15.6 Ah learned of 19.75 Ah rated. 12 Ah is the AndyMark CBA "not for competition" line, used
 * here as an assumption until gauge readings are compared with CBA tests.
 * When it fires: capacity-test the battery (AndyMark CBA, 10 A to 11 V) before it goes on the field again.
 */
import { firstPresent, num, type Match } from '../../match/match.ts'
import type { Finding, NotChecked, Rule } from '../types.ts'

const MIN_AH = 12

export const gaugeCapacity: Rule = {
  id: 'battery/gauge-capacity',
  title: 'Battery capacity low (fuel gauge)',
  fix: 'Capacity-test this battery (AndyMark CBA, 10 A to 11 V). Under 12 Ah twice means practice only.',
  incident: 'CalGames 2026 P0 battery collapse; gauge snapshots (hindsight-proposal.md §3, battery-sources.md)',
  needs: () => [],
  run(m: Match): Finding[] | NotChecked {
    const b = m.profile.battery
    const validKey = firstPresent(m, b.gaugeValid)
    const capKey = firstPresent(m, b.effectiveCapacityAh)
    if (!validKey || !capKey) return { notChecked: 'no FRC8033BatteryTracker gauge keys (BatteryGauge/Valid) in this log' }
    const valid = num(m, validKey)!
    const cap = num(m, capKey)!
    const readings: number[] = []
    for (let i = 0; i < cap.t.length; i++) {
      const j = valid.t.findLastIndex((t) => t <= cap.t[i])
      if (j >= 0 && valid.v[j] > 0.5 && cap.v[i] > 0) readings.push(cap.v[i])
    }
    if (readings.length === 0) return { notChecked: 'the fuel gauge never reported a valid reading' }
    const latest = readings[readings.length - 1]
    if (latest >= MIN_AH) return []
    const ratedKey = firstPresent(m, b.ratedCapacityAh)
    const rated = ratedKey ? num(m, ratedKey)!.v.at(-1) : undefined
    return [{
      rule: this.id,
      severity: 'warning',
      title: `Fuel gauge: effective capacity ${latest.toFixed(1)} Ah (under ${MIN_AH} Ah)`,
      time: null,
      evidence: { 'effective capacity (Ah)': +latest.toFixed(2), 'rated capacity (Ah)': rated ?? 'not logged', 'threshold (Ah)': MIN_AH },
    }]
  },
}
