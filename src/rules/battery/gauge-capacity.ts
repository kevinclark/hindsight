/**
 * Does the fuel gauge say this battery has lost capacity?
 *
 * Checks: BatteryGauge/EffectiveCapacityAh, only while BatteryGauge/Valid is true, against 12 Ah.
 * Why: CalGames 2026 P0's battery collapsed after ~3.5 Ah. The gauges learn each battery's capacity. 12 Ah is the
 * AndyMark CBA "not for competition" line, an assumption until gauge readings are compared with CBA tests.
 */
import { rule, round } from '../rule.ts'

const LEAST_AH = 12

export default rule({
  id: 'battery/gauge-capacity',
  title: 'Battery capacity low (fuel gauge)',
  severity: 'warning',
  who: ['pit'],
  fix: 'Capacity-test this battery (AndyMark CBA, 10 A to 11 V). Under 12 Ah twice means practice only.',
  incident: 'CalGames 2026 P0 battery collapse; gauge snapshots (hindsight-proposal.md §3, battery-sources.md)',

  check(match) {
    const b = match.profile.battery
    const valid = match.signal(match.firstOf(b.gaugeValid))
    const capacity = match.signal(match.firstOf(b.effectiveCapacityAh))
    const readings = capacity.series.v.filter((ah, i) => ah > 0 && valid.at(capacity.series.t[i]) > 0.5)
    if (readings.length === 0) return match.couldNotCheck('the fuel gauge never gave a valid reading')
    const latest = readings[readings.length - 1]
    if (latest >= LEAST_AH) return
    const rated = match.has(b.ratedCapacityAh[0]) || match.has(b.ratedCapacityAh[1]) ? match.signal(match.firstOf(b.ratedCapacityAh)).last() : 'not logged'
    return {
      message: `Fuel gauge: effective capacity ${latest.toFixed(1)} Ah (under ${LEAST_AH} Ah)`,
      evidence: { 'effective capacity (Ah)': round(latest), 'rated capacity (Ah)': rated, 'least OK (Ah)': LEAST_AH },
    }
  },
})
