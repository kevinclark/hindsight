/**
 * Does the fuel gauge say this battery has lost capacity?
 *
 * Checks: BatteryGauge/EffectiveCapacityAh, only while BatteryGauge/Valid is true, against 12 Ah.
 * Why: One 2026 match's battery collapsed after ~3.5 Ah. The gauges learn each battery's capacity. 12 Ah is the
 * AndyMark CBA "not for competition" line, an assumption until gauge readings are compared with CBA tests.
 */
import { rule, round } from '../rule.ts'
import { CD_BATTERY_CBA_LINE, GAME_MANUAL_2026, PWF_BATTERY_FUEL_GAUGE } from '../sources.ts'

const LEAST_AH = 12

export default rule({
  id: 'battery/gauge-capacity',
  title: 'Battery capacity low (fuel gauge)',
  severity: 'warning',
  judges: 'performance',
  who: ['pit'],
  meaning: 'The battery\'s fuel gauge has learned that this battery holds much less charge than a healthy one. It will sag early and may collapse partway through a match.',
  causes: [
    { id: 'worn', cause: 'The battery is worn out (old, or many hard cycles)', look: 'the gauge\'s effective capacity for this battery across several matches; a battery that keeps reading low is worn' },
    { id: 'damaged', cause: 'A damaged battery (left empty for a long time, over-discharged, overheated, a bad cell)', look: 'the battery itself: swollen or hot case, and how it was stored; a capacity test will show it' },
    { id: 'gauge-off', cause: 'The gauge\'s learned number is wrong (it has not seen a full cycle yet)', look: 'compare with a capacity test; check whether the reading moves after a full charge and discharge' },
  ],
  nextStep: 'Capacity-test this battery (a battery analyzer: 10 A down to 11 V). Under 12 Ah twice means practice only.',
  incident: 'One 2026 match, battery collapse; gauge snapshots (hindsight-proposal.md §3, battery-sources.md)',
  sources: [
    { ...PWF_BATTERY_FUEL_GAUGE, says: 'The gauge starts from a new 18 Ah battery and slowly learns capacity each charge/discharge cycle (faster with a full charge and a discharge at 1.8 A or less); effective capacity is what a fully charged battery could deliver now.' },
    { ...CD_BATTERY_CBA_LINE, says: 'A quoted poster puts the AM battery-analyzer figure at 12 Ah with a 10.5 V cutoff; the poster thinks the pass line should be higher and would be concerned using a battery that tested under 15 Ah, 14 at the minimum.' },
    { ...GAME_MANUAL_2026, says: 'Rule R601: the robot battery is one sealed lead acid battery of 17 Ah to 18.2 Ah nominal capacity at the 20-hour rate.' },
  ],
  thresholds: [
    { name: 'effective capacity', value: 'under 12 Ah', basis: 'judgment', how: 'The 12 Ah figure quoted in the post above, an assumption until gauge readings are compared with analyzer tests.' },
  ],

  check(match) {
    const valid = match.signal(match.batteryKey('gaugeValid'))
    const capacity = match.signal(match.batteryKey('effectiveCapacityAh'))
    // The readings above zero that the gauge marked valid at the moment it logged them.
    const readings = capacity.series.v.filter((ah, i) => ah > 0 && valid.at(capacity.series.t[i]) > 0.5)
    if (readings.length === 0) return match.couldNotCheck('the fuel gauge never gave a valid reading')
    const latest = readings[readings.length - 1]
    if (latest >= LEAST_AH) return

    const ratedKey = match.profile.battery.ratedCapacityAh
    const rated = ratedKey && match.has(ratedKey) ? match.signal(ratedKey).last() : 'not logged'
    return {
      message: `Fuel gauge: effective capacity ${latest.toFixed(1)} Ah (under ${LEAST_AH} Ah)`,
      measured: [{ label: 'effective capacity', value: round(latest), unit: 'Ah', threshold: LEAST_AH }],
      evidence: { 'effective capacity (Ah)': round(latest), 'rated capacity (Ah)': rated, 'least OK (Ah)': LEAST_AH },
    }
  },
})
