/**
 * "Download for Claude": findings.json, a self-contained summary of one match for deeper analysis later.
 *
 * Holds the findings with their evidence, summary statistics, short downsampled data windows around each finding,
 * match metadata and the fitted battery model. It never includes /RadioStatus/* (the status JSON carries a hashed
 * Wi-Fi key). Target size: under 2 MB.
 *
 * Bump SCHEMA when a field changes meaning or is removed. Adding a field doesn't need a bump.
 */

import { has, num, type Match } from '../match/match.ts'
import { maxOf, minOf, percentile, slice, type NumberSeries } from '../match/series.ts'
import { RULES, type Report } from '../rules/index.ts'
import type { Finding, Plot } from '../rules/types.ts'
import { powerReport } from '../power/power-report.ts'
import { buildPowerGrid } from '../power/battery-model.ts'

export const SCHEMA = 'hindsight.findings/1'
export { VERSION as TOOL_VERSION } from '../version.ts'
import { VERSION } from '../version.ts'
const EXCLUDED_PREFIXES = ['/RadioStatus/']
const MAX_POINTS = 300

export interface WindowSeries { label: string; key: string | null; t: number[]; v: number[] }

export function buildFindingsJson(match: Match, report: Report): object {
  const power = powerReport(match)
  return {
    schema: SCHEMA,
    tool: { name: 'hindsight', version: VERSION, rules: RULES.map((r) => r.id) },
    generatedAt: new Date().toISOString(),
    excluded: EXCLUDED_PREFIXES.map((p) => `${p}* (radio status carries a hashed Wi-Fi key)`),
    match: {
      file: match.fileName,
      event: match.event,
      match: match.matchLabel,
      fms: match.fms,
      robotProfile: match.profile.name,
      profileConfigSha: match.profile.configSha,
      build: match.build,
      log: { start: match.logStart, end: match.logEnd, entries: match.log.entries.size, records: match.log.recordCount, warnings: match.log.warnings },
      matchWindow: { start: match.matchStart, teleopStart: match.teleopStart, end: match.matchEnd },
      auto: match.auto,
      teleop: match.teleop,
      wallClockOffsetSeconds: match.epochOffset,
      dslogs: match.ds.map((d) => ({ file: d.fileName, start: d.startTime, end: d.endTime })),
    },
    findings: report.findings.map((f) => ({
      ...f,
      plot: undefined,
      audience: RULES.find((r) => r.id === f.rule)?.audience ?? [],
      fix: RULES.find((r) => r.id === f.rule)?.fix ?? null,
      incident: RULES.find((r) => r.id === f.rule)?.incident ?? null,
      window: f.plot ? windowFor(match, f.plot) : null,
    })),
    notChecked: report.skipped,
    crashedRules: report.crashed,
    summary: summary(match),
    power: power && {
      minVolts: power.minVolts, minAt: power.minAt, brownoutVolts: power.brownoutVolts, marginVolts: power.marginVolts,
      secondsUnder7: power.secondsUnder7, chargeAh: power.chargeAh, resistanceOhms: power.resistanceOhms,
      model: power.fit && { form: 'V = V0 − k·Q − R0·I (no RC term)', ...power.fit },
      modelNoChange: power.modelNoChange, ocvCurve: power.ocv, sags: power.sags, whatIfs: power.whatIfs, whatIfGroup: power.whatIfGroup,
    },
  }
}

/** Downsampled copy of each plotted line in the finding's window. */
function windowFor(match: Match, plot: Plot): { from: number; to: number; unit: string; series: WindowSeries[] } {
  const series: WindowSeries[] = []
  for (const line of plot.lines) {
    if (line.key && EXCLUDED_PREFIXES.some((p) => line.key!.startsWith(p))) continue
    const s = line.data ?? (line.key && has(match, line.key) ? num(match, line.key) : null)
    if (!s) continue
    const part = downsample(slice(s, plot.from, plot.to), MAX_POINTS)
    const scale = line.scale ?? 1
    series.push({ label: line.label, key: line.key ?? null, t: part.t.map((x) => +x.toFixed(3)), v: part.v.map((x) => +(x * scale).toFixed(3)) })
  }
  return { from: plot.from, to: plot.to, unit: plot.unit, series }
}

/** Keep at most `max` points, keeping each bucket's min and max so spikes survive. */
export function downsample(s: NumberSeries, max: number): { t: number[]; v: number[] } {
  const n = s.t.length
  if (n <= max) return { t: Array.from(s.t), v: Array.from(s.v) }
  const buckets = Math.floor(max / 2)
  const t: number[] = []
  const v: number[] = []
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * n) / buckets)
    const to = Math.floor(((b + 1) * n) / buckets)
    let lo = from, hi = from
    for (let i = from; i < to; i++) { if (s.v[i] < s.v[lo]) lo = i; if (s.v[i] > s.v[hi]) hi = i }
    for (const i of lo <= hi ? [lo, hi] : [hi, lo]) { if (t.at(-1) !== s.t[i]) { t.push(s.t[i]); v.push(s.v[i]) } }
  }
  return { t, v }
}

/** Per-signal summary statistics over the match. */
function summary(match: Match): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const inMatch = (s: NumberSeries) => match.matchStart === null ? s : slice(s, match.matchStart, match.matchEnd ?? Infinity)
  const stat = (label: string, key: string) => {
    if (!has(match, key)) return
    const s = inMatch(num(match, key)!)
    if (s.v.length === 0) return
    out[label] = { key, n: s.v.length, min: +minOf(s.v).toFixed(3), p5: +percentile(s.v, 5).toFixed(3), median: +percentile(s.v, 50).toFixed(3), p95: +percentile(s.v, 95).toFixed(3), max: +maxOf(s.v).toFixed(3) }
  }
  stat('battery voltage (V)', match.profile.signals.batteryVoltage)
  stat('loop cycle (ms)', match.profile.signals.loopCycleMs)
  const g = buildPowerGrid(match)
  if (g) {
    for (const group of g.groups) {
      const xs = group.amps.filter((_, i) => g.enabled[i] === 1)
      if (xs.length) out[`${group.name} supply current (A)`] = { median: +percentile(xs, 50).toFixed(1), p95: +percentile(xs, 95).toFixed(1), max: +maxOf(xs).toFixed(1) }
    }
  }
  return out
}

export function findingsFileName(match: Match): string {
  return `${match.fileName.replace(/\.wpilog$/i, '')}.findings.json`
}

export type { Finding }
