/** The numbers the Session view's Trends small multiples and the printed Session report both draw. */
import type { MatchMetrics } from './summary.ts'

/** Each with the rule's line where there is one. */
export const TREND_METRICS: { key: keyof MatchMetrics; label: string; unit: string; digits: number; line?: number }[] = [
  { key: 'minVolts', label: 'Lowest voltage', unit: 'V', digits: 2, line: 7 },
  { key: 'secondsUnder7', label: 'Time under 7 V', unit: 's', digits: 1 },
  { key: 'chargeAh', label: 'Charge drawn', unit: 'Ah', digits: 2 },
  { key: 'resistanceMilliohms', label: 'Battery + wiring', unit: 'mΩ', digits: 1, line: 20 },
  { key: 'followerSpeedPct', label: 'Slowest follower vs leader', unit: '%', digits: 0, line: 85 },
  { key: 'loopOverrunPct', label: 'Auto loops over 20 ms', unit: '%', digits: 1, line: 10 },
  { key: 'visionOutlierPct', label: 'Vision poses > 0.5 m off', unit: '%', digits: 1, line: 5 },
]
