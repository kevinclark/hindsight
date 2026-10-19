/**
 * Foresight's one verdict: GO, NO-GO or NOT CHECKED, then the findings worst first.
 *
 * Every check is amber unless the backtest earned it red (proven.ts): red means "this will likely cost the match, and
 * you can fix it before the robot goes on the field". NO-GO when anything is red. NOT CHECKED when a check that can go red could not read
 * its signal, since its silence would otherwise read as green. Context (info) stays grey and never moves the verdict.
 */
import type { Report, SkippedRule } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import { PROVEN, type Proof } from './proven.ts'

export type Level = 'red' | 'amber' | 'grey'

export interface VerdictItem {
  finding: Finding
  level: Level
  /** "proven on 3 match logs (…)" for red; why it is still amber otherwise. */
  proof: string
  /** The one thing to do before the robot goes on the field. */
  action: string
}

export interface Verdict {
  verdict: 'GO' | 'NO-GO' | 'NOT CHECKED'
  reason: string
  items: VerdictItem[]
  /** Checks that could not run (or ran only in part), and why. */
  notChecked: SkippedRule[]
  crashed: SkippedRule[]
}

const RANK: Record<Level, number> = { red: 0, amber: 1, grey: 2 }

export function proofText(rule: string, proven: Record<string, Proof> = PROVEN): string {
  const p = proven[rule]
  if (!p) return 'amber until a backtest on field logs shows no false reds'
  const fired = p.fires ? `fired on ${p.fires}, all real` : 'never fired there'
  return `proven on ${p.logs} match log${p.logs === 1 ? '' : 's'}, ${fired} (${p.base}, ${p.date})`
}

/**
 * `unproven`: checks that stay amber this time although proven, with why (e.g. rest voltage just after a drive, a
 * situation the backtest never covered).
 */
export function verdictFor(report: Report, proven: Record<string, Proof> = PROVEN, unproven: Record<string, string> = {}): Verdict {
  const items: VerdictItem[] = report.findings
    .filter((f) => f.rule !== 'meta/not-checked')
    .map((finding) => {
      const red = !!proven[finding.rule] && !unproven[finding.rule]
      const level: Level = finding.severity === 'info' ? 'grey' : red ? 'red' : 'amber'
      const proof = level === 'grey' ? 'context' : unproven[finding.rule] ?? proofText(finding.rule, proven)
      return { finding, level, proof, action: finding.nextStep }
    })
    .sort((a, b) => RANK[a.level] - RANK[b.level])
  const reds = items.filter((i) => i.level === 'red')
  const ambers = items.filter((i) => i.level === 'amber')
  const blind = [...report.skipped.filter((s) => !s.reason.startsWith('partly')), ...report.crashed].filter((s) => proven[s.rule])
  const base = { items, notChecked: report.skipped, crashed: report.crashed }
  if (reds.length) return { ...base, verdict: 'NO-GO', reason: `${reds.length} to fix before the robot goes on the field` }
  if (blind.length) return { ...base, verdict: 'NOT CHECKED', reason: `could not check ${blind.map((s) => `${s.rule} (${s.reason})`).join('; ')}` }
  return { ...base, verdict: 'GO', reason: ambers.length ? `${ambers.length} to look at (amber)` : 'nothing found' }
}
