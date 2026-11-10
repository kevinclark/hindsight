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
    const volts = typeof m.metrics.belowHealthyVolts === 'number' ? m.metrics.belowHealthyVolts : null
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

/** The verdict words for one battery. */
export function batteryVerdict(row: BatteryRow, line: number): string {
  if (row.measured === 0) return 'Not measured: these logs have no battery voltage and motor currents to compare with.'
  const of = `${row.measured} ${row.measured === 1 ? 'match' : 'matches'}`
  if (row.pastCount > 0) return `More than ${line} V below a healthy battery in ${row.pastCount} of ${of}: capacity-test it before it plays again.`
  const partly = row.matches.filter((m) => m.partly && m.volts !== null).length
  const upTo = partly === 0 ? '' : partly === row.measured ? `, compared only up to ${LAST_REFERENCE_AH} Ah` : `, ${partly} compared only up to ${LAST_REFERENCE_AH} Ah`
  return `Within ${line} V of a healthy battery in ${row.measured === 1 ? 'its' : 'all'} ${of}${upTo}.`
}
