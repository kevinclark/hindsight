/**
 * The numbers the Session view's Trends table and the printed Session report both draw, and what they say about
 * them. One model (`trendRows`) so the screen and the paper cannot disagree on a verdict, a worst match or an order.
 */
import { RULES } from '../rules/index.ts'
import { shortMatchLabel } from '../ui/match-label.ts'
import type { MatchMetrics, MatchSummary } from './summary.ts'

export interface TrendMetric {
  key: keyof MatchMetrics
  label: string
  unit: string
  digits: number
  /** The rule's line, where there is one. For lowest voltage it is the default only: each log's own line is its brownout setting + 1 V. */
  line?: number
  /** Which side of the line is bad. Absent where there is no line. */
  bad?: 'below' | 'above'
  /** The rule that owns this number (its id), where there is one. */
  rule?: string
  /** A second line of words under the label. */
  sub?: string
  /** The line counts as passed when the value equals it (the follower rule fires at "1 s or more"). */
  atLinePasses?: boolean
}

/** The brownout setting + 1.0 V that power/margin judges against; 6.0 V is the roboRIO 2 default when a log has no setting. */
export const MARGIN_VOLTS = 1
export const DEFAULT_BROWNOUT = 6

export const TREND_METRICS: TrendMetric[] = [
  { key: 'minVolts', label: 'Lowest voltage', unit: 'V', digits: 2, line: DEFAULT_BROWNOUT + MARGIN_VOLTS, bad: 'below', rule: 'power/margin' },
  { key: 'secondsUnder7', label: 'Time under 7 V', unit: 's', digits: 1 },
  { key: 'chargeAh', label: 'Charge drawn', unit: 'Ah', digits: 2 },
  { key: 'resistanceMilliohms', label: 'Battery + wiring', unit: 'mΩ', digits: 1, line: 20, bad: 'above', rule: 'power/wiring-resistance' },
  { key: 'followerSecondsOff', label: 'Follower more than 15 % off its leader', unit: 's', digits: 1, line: 1, bad: 'above', rule: 'mech/follower-mismatch', atLinePasses: true },
  { key: 'loopOverrunPct', label: 'Auto loops over 20 ms', unit: '%', digits: 1, line: 10, bad: 'above', rule: 'loop/overrun', sub: 'Auto only here; the rule also counts teleop.' },
  { key: 'visionOutlierPct', label: 'Vision poses > 0.5 m off', unit: '%', digits: 1, line: 5, bad: 'above', rule: 'vision/outliers' },
]

export type NextStepSource = 'rule' | 'match' | 'within' | 'no-rule' | 'none'

export interface TrendRow {
  metric: TrendMetric
  /** One entry per match, in the given order; null where the log did not carry the number. */
  values: (number | null)[]
  /** The line for each match (the brownout row's differs by log); null for a row without a line. */
  lines: (number | null)[]
  /** The line drawn: the most common one. */
  line: number | null
  lineVaries: boolean
  /** Short label for each match. */
  labels: string[]
  /** Matches with a value, of all matches (N). */
  n: number
  total: number
  /** Per match: past the line on the bad side. Always false for a row without a line or a missing value. */
  past: boolean[]
  pastCount: number
  /** Index of the worst match (furthest on the bad side; for a row without a line, the highest), or null with no values. */
  worstIndex: number | null
  /** 'worst' for a row with a line; 'highest' for one without. */
  worstWord: 'worst' | 'highest'
  latest: number | null
  /** The last match is strictly the worst, and something is past the line (or the row has no line). */
  latestIsWorst: boolean
  /** The verdict sentence. */
  verdict: string
  /** The second verdict line: "Latest is the worst (Q42)" or ''. */
  verdict2: string
  /** What to do: the text (without quotes), where it came from, and the rule's id to show beside it. */
  next: { text: string; source: NextStepSource; ruleId: string | null }
  /** How far past: the worst value against the line, oriented to the bad side (1 = on the line). Null with no line or no values. */
  pastRatio: number | null
  /** Smaller sorts first. */
  sortKey: number
}

const format = (v: number, digits: number) => v.toFixed(digits)

/** The first sentence of a rule's next step. */
export function firstSentence(text: string): string {
  const m = /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim())
  return (m ? m[0] : text).trim()
}

/**
 * A match's short label for the Trends table. A log with no match number is labelled from /DriverStation/MatchType
 * (practice: "Pr"; none: "On field", on the field outside a scheduled match), never from its file name; with no such signal it keeps its position, "#3".
 */
export function trendLabel(m: MatchSummary, index: number): string {
  if (m.matchLabel.trim()) return shortMatchLabel(m.matchLabel, index)
  if (m.matchType === 1) return 'Pr'
  if (m.matchType === 0) return 'On field'
  return shortMatchLabel('', index)
}

/** The same in full, for a tooltip or a title. */
export function trendLabelLong(m: MatchSummary, index: number): string {
  if (m.matchLabel.trim()) return m.matchLabel
  if (m.matchType === 1) return 'Practice (no match number logged)'
  if (m.matchType === 0) return 'On the field outside a scheduled match (FMS sent no match type)'
  return `Log ${index + 1} (${m.fileName})`
}

const mode = (xs: number[]) => {
  const counts = new Map<number, number>()
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null
}

/** The line one match is judged against. */
function lineFor(metric: TrendMetric, m: MatchSummary): number | null {
  if (metric.line === undefined) return null
  if (metric.key !== 'minVolts') return metric.line
  const setting = m.metrics.brownoutVolts
  return (typeof setting === 'number' && Number.isFinite(setting) ? setting : DEFAULT_BROWNOUT) + MARGIN_VOLTS
}

export function trendRows(matches: MatchSummary[]): TrendRow[] {
  const labels = matches.map((m, i) => trendLabel(m, i))
  const rows = TREND_METRICS.map((metric): TrendRow => {
    const values = matches.map((m) => {
      const v = m.metrics[metric.key]
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    })
    const lines = matches.map((m) => lineFor(metric, m))
    const n = values.filter((v) => v !== null).length
    const hasLine = metric.line !== undefined && metric.bad !== undefined
    const sign = metric.bad === 'below' ? -1 : 1
    const past = values.map((v, i) => {
      if (v === null || !hasLine) return false
      const l = lines[i]!
      return metric.bad === 'below' ? v < l : metric.atLinePasses ? v >= l : v > l
    })
    const pastCount = past.filter(Boolean).length
    // Furthest on the bad side (lowest for 'below', highest otherwise); the highest where there is no line.
    let worstIndex: number | null = null
    values.forEach((v, i) => {
      if (v === null) return
      if (worstIndex === null || sign * v > sign * values[worstIndex]!) worstIndex = i
    })
    const line = hasLine ? mode(lines.filter((l): l is number => l !== null)) : null
    const lineVaries = hasLine && new Set(lines).size > 1
    const lastIndex = matches.length - 1
    const latest = lastIndex >= 0 ? values[lastIndex] : null
    const strictlyWorst = worstIndex === lastIndex && latest !== null && values.every((v, i) => v === null || i === lastIndex || sign * v < sign * latest)
    const latestIsWorst = n > 1 && strictlyWorst && (!hasLine || pastCount > 0)
    const worstWord = hasLine ? 'worst' : 'highest'

    const total = matches.length
    let verdict: string
    if (n === 0) verdict = 'not in these logs'
    else if (!hasLine) verdict = `No line: ${format(Math.min(...(values.filter((v) => v !== null) as number[])), metric.digits)} to ${format(Math.max(...(values.filter((v) => v !== null) as number[])), metric.digits)} ${metric.unit}`
    else {
      const side = metric.bad === 'below' ? 'Under' : 'Over'
      const lineText = lineVaries ? 'its brownout setting + 1 V' : `${+line!.toFixed(2)} ${metric.unit}`
      const missing = total - n
      verdict = missing === 0
        ? `${side} ${lineText} in ${pastCount} of ${total} matches`
        : `${side} ${lineText} in ${pastCount} of ${n} measured (${missing} not logged)`
    }
    const verdict2 = latestIsWorst ? `Latest is the ${worstWord} (${labels[lastIndex]})` : ''

    // What to do.
    const rule = metric.rule ? RULES.find((r) => r.id === metric.rule) : undefined
    let next: TrendRow['next']
    if (n === 0) next = { text: '', source: 'none', ruleId: null }
    else if (!hasLine) next = { text: 'No rule for this number', source: 'no-rule', ruleId: null }
    else if (pastCount === 0) next = { text: 'Nothing: within the line', source: 'within', ruleId: metric.rule ?? null }
    else {
      const own = worstIndex === null ? undefined : matches[worstIndex].rules[metric.rule!]?.findings.find((f) => f.nextStep && f.severity !== 'info')?.nextStep
      if (own) next = { text: firstSentence(own), source: 'match', ruleId: metric.rule ?? null }
      else next = { text: rule ? firstSentence(rule.nextStep) : '', source: rule ? 'rule' : 'none', ruleId: metric.rule ?? null }
    }

    let pastRatio: number | null = null
    if (hasLine && worstIndex !== null) {
      const w = values[worstIndex]!, l = lines[worstIndex]!
      pastRatio = metric.bad === 'below' ? (w > 0 ? l / w : 999) : l > 0 ? w / l : 999
    }
    // Tiers: past the line in any match (lowest voltage first, the brownout row; then by how far past, biggest
    // first: a ratio to the line would put volts last, 7/5.69 = 1.23 against 8.7 for vision), within the line, no
    // line, absent. Kevin, 2026-10-20.
    const tier = n === 0 ? 3 : !hasLine ? 2 : pastCount > 0 ? 0 : 1
    const sortKey = tier * 1000 - (tier === 0 ? (metric.key === 'minVolts' ? 999 : Math.min(pastRatio ?? 0, 998)) : 0)
    return { metric, values, lines, line, lineVaries, labels, n, total, past, pastCount, worstIndex, worstWord, latest, latestIsWorst, verdict, verdict2, next, pastRatio, sortKey }
  })
  // Stable: equal keys keep the metric order above.
  return rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.sortKey - b.r.sortKey || a.i - b.i).map((x) => x.r)
}
