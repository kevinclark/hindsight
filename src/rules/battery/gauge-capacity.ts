/**
 * Does the fuel gauge say this battery has lost capacity?
 *
 * Checks: BatteryGauge/EffectiveCapacityAh, only while BatteryGauge/Valid is true, against 12 Ah.
 * Why: CalGames 2026 P0's battery collapsed after ~3.5 Ah. The gauges learn each battery's capacity. 12 Ah is the
 * AndyMark CBA "not for competition" line, an assumption until gauge readings are compared with CBA tests.
 */
import { rule, round } from '../rule.ts'
import type { Signal } from '../view.ts'

const LEAST_AH = 12

export default rule({
  id: 'battery/gauge-capacity',
  title: 'Battery capacity low (fuel gauge)',
  severity: 'warning',
  who: ['pit'],
  meaning: 'The battery\'s fuel gauge has learned that this battery holds much less charge than a healthy one. It will sag early and may collapse partway through a match.',
  causes: [
    { id: 'worn', cause: 'The battery is worn out (old, or many hard cycles)', look: 'the gauge\'s effective capacity for this battery across several matches; a battery that keeps reading low is worn' },
    { id: 'damaged', cause: 'A damaged battery (left empty for a long time, over-discharged, overheated, a bad cell)', look: 'the battery itself: swollen or hot case, and how it was stored; a capacity test will show it' },
    { id: 'gauge-off', cause: 'The gauge\'s learned number is wrong (it has not seen a full cycle yet)', look: 'compare with a capacity test; check whether the reading moves after a full charge and discharge' },
  ],
  nextStep: 'Capacity-test this battery (a battery analyzer: 10 A down to 11 V). Under 12 Ah twice means practice only.',
  incident: 'CalGames 2026 P0 battery collapse; gauge snapshots (hindsight-proposal.md §3, battery-sources.md)',

  check(match) {
    const b = match.profile.battery
    const valid = match.signal(match.firstOf(b.gaugeValid))
    const capacity = match.signal(match.firstOf(b.effectiveCapacityAh))
    const readings = validReadings(capacity, valid)
    if (readings.length === 0) return match.couldNotCheck('the fuel gauge never gave a valid reading')
    const latest = readings[readings.length - 1]
    if (latest >= LEAST_AH) return

    const hasRated = b.ratedCapacityAh.some((key) => match.has(key))
    const rated = hasRated ? match.signal(match.firstOf(b.ratedCapacityAh)).last() : 'not logged'
    return {
      message: `Fuel gauge: effective capacity ${latest.toFixed(1)} Ah (under ${LEAST_AH} Ah)`,
      measured: [{ label: 'effective capacity', value: round(latest), unit: 'Ah', threshold: LEAST_AH }],
      evidence: { 'effective capacity (Ah)': round(latest), 'rated capacity (Ah)': rated, 'least OK (Ah)': LEAST_AH },
    }
  },
})

/** The capacity readings (Ah) above zero that the gauge marked valid at the moment it logged them. */
function validReadings(capacity: Signal, gaugeValid: Signal): number[] {
  const readings: number[] = []
  for (let i = 0; i < capacity.series.v.length; i++) {
    const ah = capacity.series.v[i]
    const loggedAt = capacity.series.t[i]
    if (ah > 0 && gaugeValid.at(loggedAt) > 0.5) readings.push(ah)
  }
  return readings
}
