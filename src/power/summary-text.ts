/**
 * The Power tab as plain text for a chat message: the match, lowest voltage, time under the sag line, charge and energy,
 * then one line per motor group. Wrapped in a ``` fence so Slack shows it monospaced. Numbers use the tab's own
 * decimals so a reader can match the two. Pure; no DOM. Nothing reads it but the tab's Copy summary button.
 */

import { matchWhen, type Match } from '../match/match.ts'
import { robotName } from '../profiles/choose.ts'
import { matchDateOf } from '../report/review-model.ts'
import { buildPowerGrid } from './battery-model.ts'
import { buildBreakdown } from './breakdown.ts'
import { powerReport } from './power-report.ts'
import { buildSagSpans } from './sag-spans.ts'

const FENCE = '```'
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—')
const a1 = (x: number | null) => (x === null ? '' : x.toFixed(1))
const pct = (x: number, total: number) => (total > 0 ? `${((100 * x) / total).toFixed(0)} %` : '—')
const LABEL = 26

export function powerSummaryText(match: Match): string | null {
  const p = powerReport(match)
  const g = buildPowerGrid(match)
  const b = buildBreakdown(match)
  const sag = buildSagSpans(match)
  if (!p || !g || !b || !sag) return null

  // The header as the Match review's report header writes it.
  const date = matchDateOf(match)
  const head = [robotName(match.profile.name, match.profileChoice), ...(match.event ? [match.event] : []), match.matchLabel || 'Match', ...(date ? [date] : [])].join(' · ')

  const line = Number.isFinite(sag.line) ? `${+sag.line.toFixed(2)}` : ''
  const sagText = sag.mode === 'stretches'
    ? `${sag.secondsUnderLine.toFixed(1)} s, ${sag.totalSpans} ${sag.totalSpans === 1 ? 'sag' : 'sags'}`
    : line ? `never under ${line} V` : 'no brownout setting'
  const kv = (k: string, v: string) => `${k.padEnd(LABEL)}${v}`

  const w = Math.max(5, ...b.rows.map((r) => r.name.length)) + 2
  const row = (name: string, wh: string, share: string, p90: string, peak: string) =>
    (name.padEnd(w) + wh.padStart(7) + share.padStart(7) + p90.padStart(8) + peak.padStart(8)).trimEnd()

  return [
    FENCE,
    head,
    kv('Lowest voltage (enabled)', `${f2(p.minVolts)} V at ${matchWhen(match, p.minAt)}`),
    kv('Margin to brownout', Number.isFinite(p.brownoutVolts)
      ? `${f2(p.marginVolts)} V (setting ${p.brownoutVolts} V; want >= ${match.profile.power.marginVolts} V)`
      : 'no brownout setting'),
    kv(line ? `Under ${line} V` : 'Under the sag line', sagText),
    kv('Charge drawn', `${p.chargeAh.toFixed(2)} Ah`),
    kv('Energy', `${b.totalWh.toFixed(1)} Wh`),
    '',
    row('Group', 'Wh', 'Share', 'P90 A', 'Peak A'),
    ...b.rows.map((r) => row(r.name, r.wh.toFixed(1), pct(r.wh, b.totalWh), a1(r.p90), a1(r.peak))),
    FENCE,
  ].join('\n')
}
