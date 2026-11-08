/**
 * Match review from a summary, for the phone (stage 1: no plots). A summary keeps each finding's words and numbers and what
 * the log said about its causes; the rule's own text (meaning, causes, next step, who acts) comes from the rule in this
 * build's code, as the session's findings already do. No `node:` imports.
 */
import { makerOf } from '../rules/index.ts'
import type { MatchSummary, SummaryFinding } from '../session/summary.ts'

export interface ReviewRow {
  finding: SummaryFinding
  meaning: string | null
  nextStep: string | null
  causes: { id: string; cause: string; look: string; likely: boolean; ruledOut: string | null }[]
  who: string
  /** Why the rule exists, when this build knows the rule. */
  incident: string | null
}

const SEVERITY = { error: 0, warning: 1, info: 2 } as const
const WHO = { software: 'software team', pit: 'pit crew', drive: 'drive team' } as const

/** Every finding in the summary, worst first (the rules' own order within a severity), with its rule's text. */
export function reviewRows(summary: MatchSummary): ReviewRow[] {
  const all = Object.values(summary.rules).flatMap((r) => r.findings)
  return all.map((f, i) => ({ f, i })).sort((a, b) => SEVERITY[a.f.severity] - SEVERITY[b.f.severity] || a.i - b.i).map(({ f }) => {
    const rule = makerOf(f.rule)
    return {
      finding: f,
      meaning: rule?.meaning ?? null,
      nextStep: f.nextStep ?? rule?.nextStep ?? null,
      causes: (rule?.causes ?? []).map((c) => ({ id: c.id, cause: c.cause, look: c.look, likely: f.likely.includes(c.id), ruledOut: f.ruledOut[c.id] ?? null })),
      who: rule ? rule.who.map((a) => WHO[a]).join(', ') : '',
      incident: rule && 'incident' in rule ? rule.incident : null,
    }
  })
}

/** The rules that could not be checked on this log, with why. */
export function notChecked(summary: MatchSummary): { rule: string; reason: string }[] {
  return Object.entries(summary.rules).filter(([, r]) => r.status === 'not checked').map(([rule, r]) => ({ rule, reason: r.reason ?? '' }))
}
