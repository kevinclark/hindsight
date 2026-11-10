/**
 * The Session view's Batteries table: each battery's matches, with how far it fell below a healthy battery at the same
 * charge drawn (power/battery-collapse's number, MatchMetrics.belowHealthyVolts), worst battery first. Open a battery's
 * matches from the Library (its battery filter) to see one battery across events.
 */
import { LAST_REFERENCE_AH, MOST_BELOW_HEALTHY } from '../rules/power/battery-health.ts'
import type { MatchSummary } from './summary.ts'
import { trendLabel, trendLabelLong } from './trends.ts'

export interface BatteryMatch {
  summary: MatchSummary
  /** Short label ("Q29") and the long one for a tooltip. */
  label: string
  longLabel: string
  /** V below a healthy battery at its worst point (negative: above), and at what charge drawn; null when not measured. */
  volts: number | null
  ah: number | null
  /** More than the rule's line below: power/battery-collapse fired, or would. */
  past: boolean
  /** Drew more charge than the healthy curve covers: compared only up to its end. */
  partly: boolean
}

export interface BatteryRow {
  battery: string
  matches: BatteryMatch[]
  /** The match furthest below, or null when no match was measured. */
  worst: BatteryMatch | null
  pastCount: number
  measured: number
}

export interface BatteryTable {
  rows: BatteryRow[]
  /** Matches with no battery name, logged or typed. */
  unnamed: number
  line: number
  /** Where the healthy battery curve ends (Ah). */
  curveEndAh: number
}

export function batteryTable(matches: MatchSummary[], typedBatteries: Record<string, string> = {}): BatteryTable {
  const name = (m: MatchSummary) => (m.batteryId ?? typedBatteries[m.fileName] ?? '').trim()
  const byBattery = new Map<string, BatteryMatch[]>()
  matches.forEach((m, i) => {
    const b = name(m)
    if (!b) return
    const volts = typeof m.metrics.belowHealthyVolts === 'number' && Number.isFinite(m.metrics.belowHealthyVolts) ? m.metrics.belowHealthyVolts : null
    const entry: BatteryMatch = {
      summary: m, label: trendLabel(m, i), longLabel: trendLabelLong(m, i),
      volts, ah: m.metrics.belowHealthyAh ?? null, past: volts !== null && volts > MOST_BELOW_HEALTHY, partly: m.metrics.pastHealthyCurve === true,
    }
    byBattery.set(b, [...(byBattery.get(b) ?? []), entry])
  })
  const rows = [...byBattery].map(([battery, ms]): BatteryRow => {
    const measured = ms.filter((x) => x.volts !== null)
    const worst = measured.reduce<BatteryMatch | null>((a, x) => (a === null || x.volts! > a.volts! ? x : a), null)
    return { battery, matches: ms, worst, pastCount: ms.filter((x) => x.past).length, measured: measured.length }
  })
  // Worst battery first; batteries with nothing measured last, by name.
  rows.sort((a, b) => (b.worst?.volts ?? -Infinity) - (a.worst?.volts ?? -Infinity) || a.battery.localeCompare(b.battery))
  return { rows, unnamed: matches.filter((m) => !name(m)).length, line: MOST_BELOW_HEALTHY, curveEndAh: LAST_REFERENCE_AH }
}

/**
 * The verdict words for one battery. "Within" only for matches compared over all the charge they drew: a match that drew
 * more than the healthy curve covers is not judged past its end, so it says how far below it was there, no verdict.
 */
export function batteryVerdict(row: BatteryRow, line: number): string {
  if (row.measured === 0) {
    return row.matches.every((m) => m.summary.metrics.belowHealthyVolts === undefined)
      ? 'Not compared yet: read these logs again to compare this battery with a healthy one.'
      : 'Not measured: these logs have too little battery voltage, motor current or current change to compare with a healthy battery.'
  }
  const count = (n: number) => `${n} ${n === 1 ? 'match' : 'matches'}`
  if (row.pastCount > 0) return `More than ${line} V below a healthy battery in ${row.pastCount} of ${count(row.measured)}: capacity-test it before it plays again.`
  const measured = row.matches.filter((m) => m.volts !== null)
  const partly = measured.filter((m) => m.partly)
  const full = measured.length - partly.length
  const all = (n: number) => (n === 1 ? 'its 1 match' : n === 2 ? 'both matches' : `all ${n} matches`)
  if (partly.length === 0) return `Within ${line} V of a healthy battery in ${all(full)}.`
  const worstPartly = partly.reduce((a, m) => (m.volts! > a.volts! ? m : a))
  const notJudged = `Not judged past ${LAST_REFERENCE_AH} Ah in ${partly.length === measured.length ? all(partly.length) : count(partly.length)} (it drew more): up to ${worstPartly.volts!.toFixed(2)} V below a healthy battery there`
  return full === 0 ? `${notJudged}.` : `${notJudged}; within ${line} V in the other ${count(full)}.`
}
