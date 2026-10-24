/**
 * Foresight's one verdict: GO, NO-GO or NOT CHECKED, then the findings worst first.
 *
 * Every check is amber unless the backtest earned it red (proven.ts): red means "this will likely cost the match, and
 * you can fix it before the robot goes on the field". NO-GO when anything is red. NOT CHECKED when a check that can go red could not read
 * its signal, since its silence would otherwise read as green. Context (info) stays grey and never moves the verdict.
 * A finding another finding explains (src/rules/links.ts) sits under it, not as an item of its own, when what explains
 * it is at least as serious here: one problem, one item. Nothing is dropped: allItems() still lists it.
 */
import type { Report, SkippedRule } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import { earnsRed, PROVEN, type Proof } from './proven.ts'
import { explainerOf } from '../report/finding-tree.ts'

export type Level = 'red' | 'amber' | 'grey'

export interface VerdictItem {
  finding: Finding
  level: Level
  /** "proven on 3 match logs (…)" for red; why it is still amber otherwise. */
  proof: string
  /** The one thing to do before the robot goes on the field. */
  action: string
  /** The items this one explains, each with its `finding.explainedBy.why`. */
  explains: VerdictItem[]
}

export interface Verdict {
  verdict: 'GO' | 'NO-GO' | 'NOT CHECKED'
  reason: string
  /** Worst first; an item that another explains is under it (`explains`), not here. */
  items: VerdictItem[]
  /** Checks that could not run (or ran only in part), and why. */
  notChecked: SkippedRule[]
  crashed: SkippedRule[]
  /** The checks that could not run and that could have gone red: what makes the verdict NOT CHECKED. */
  blind: SkippedRule[]
}

const RANK: Record<Level, number> = { red: 0, amber: 1, grey: 2 }

export function proofText(rule: string, proven: Record<string, Proof> = PROVEN): string {
  const p = proven[rule]
  if (!p) return 'amber until a backtest on field logs shows no false reds'
  const logs = `${p.logs} match log${p.logs === 1 ? '' : 's'}`
  if (!earnsRed(p)) return `amber until it catches a real fault on one of our logs (no false reds on ${logs}; ${p.base}, ${p.date})`
  return `proven on ${logs}, fired on ${p.fires}, all real (${p.base}, ${p.date})`
}

/**
 * `unproven`: checks that stay amber this time although proven, with why (e.g. rest voltage just after a drive, a
 * situation the backtest never covered).
 */
export function verdictFor(report: Report, proven: Record<string, Proof> = PROVEN, unproven: Record<string, string> = {}): Verdict {
  const all: VerdictItem[] = report.findings
    .filter((f) => f.rule !== 'meta/not-checked')
    .map((finding) => {
      const red = earnsRed(proven[finding.rule]) && !unproven[finding.rule]
      const level: Level = finding.severity === 'info' ? 'grey' : red ? 'red' : 'amber'
      const proof = level === 'grey' ? 'context' : unproven[finding.rule] ?? proofText(finding.rule, proven)
      return { finding, level, proof, action: finding.nextStep, explains: [] as VerdictItem[] }
    })
    .sort((a, b) => RANK[a.level] - RANK[b.level])
  // Under what explains it only if that is at least as serious here, so a link never hides a red under an amber.
  const parentOf = (item: VerdictItem) => {
    const by = explainerOf(item.finding, report.findings)
    const parent = by && all.find((p) => p.finding === by)
    return parent && RANK[parent.level] <= RANK[item.level] ? parent : undefined
  }
  const parents = new Map(all.map((item) => [item, parentOf(item)]))
  for (const [item, parent] of parents) parent?.explains.push(item)
  const items = all.filter((item) => !parents.get(item))
  const reds = items.filter((i) => i.level === 'red')
  const ambers = items.filter((i) => i.level === 'amber')
  const blind = [...report.skipped.filter((s) => !s.reason.startsWith('partly')), ...report.crashed].filter((s) => earnsRed(proven[s.rule]))
  const base = { items, notChecked: report.skipped, crashed: report.crashed, blind }
  if (reds.length) return { ...base, verdict: 'NO-GO', reason: `${reds.length} to fix before the robot goes on the field` }
  if (blind.length) return { ...base, verdict: 'NOT CHECKED', reason: `could not check ${blind.map((s) => `${s.rule} (${s.reason})`).join('; ')}` }
  return { ...base, verdict: 'GO', reason: ambers.length ? `${ambers.length} to look at (amber)` : 'nothing found' }
}

/** Every item, the ones under another included, in order. */
export function allItems(verdict: Pick<Verdict, 'items'>): VerdictItem[] {
  const walk = (i: VerdictItem): VerdictItem[] => [i, ...i.explains.flatMap(walk)]
  return verdict.items.flatMap(walk)
}
