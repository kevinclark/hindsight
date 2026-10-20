/**
 * Findings as headlines with the findings they explain under them (from `explainedBy`, set by src/rules/links.ts).
 * The Match tab, the printed report and the phone card all list findings this way. Counts never use it: every
 * finding still counts, nested or not.
 */

import type { Finding, Severity } from '../rules/types.ts'
import { shortTitle } from './titles.ts'

export interface FindingNode {
  finding: Finding
  /** The findings it explains that are in the same list, in report order. */
  children: FindingNode[]
  /** On a finding something explains but that is listed as a headline anyway: why, in words. */
  note?: string
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** The finding that explains this one, if it is among `all`. */
export function explainerOf(f: Finding, all: Finding[]): Finding | undefined {
  const by = f.explainedBy
  return by && all.find((c) => c.rule === by.rule && c.about === by.about && c.time === by.time)
}

/**
 * The list as headlines, each with the findings it explains nested under it. A finding is nested only when what
 * explains it is in the same list and is at least as serious; otherwise it stays a headline with a note saying what
 * explains it, so a link never hides a red under an amber. A finding that came back after a fix stays a headline
 * too. `known`: every finding filed as a known issue; `cameBack`: findings that came back after a fix.
 */
export function nest(list: Finding[], all: Finding[], known: Finding[] = [], cameBack: Finding[] = []): FindingNode[] {
  const inList = new Set(list)
  const parentInList = (f: Finding) => {
    const parent = explainerOf(f, all)
    const nestable = parent && inList.has(parent) && RANK[f.severity] >= RANK[parent.severity] && !cameBack.includes(f)
    return nestable ? parent : undefined
  }
  const node = (f: Finding): FindingNode => ({ finding: f, children: list.filter((c) => parentInList(c) === f).map(node) })
  return list.filter((f) => !parentInList(f)).map((f) => ({ ...node(f), note: noteFor(f, all, known) }))
}

/** "explained by a known issue (<its short title>): <why>", or the same without "a known issue", for a headline. */
function noteFor(f: Finding, all: Finding[], known: Finding[]): string | undefined {
  const parent = explainerOf(f, all)
  if (!parent || !f.explainedBy) return undefined
  const what = known.includes(parent) ? `a known issue (${shortTitle(parent.title)})` : shortTitle(parent.title)
  return `explained by ${what}: ${f.explainedBy.why}`
}

/** Every finding under a node, at any depth. */
export function descendants(n: FindingNode): Finding[] {
  return n.children.flatMap((c) => [c.finding, ...descendants(c)])
}

/** Every finding under a node with how deep it sits (1 = explained by the headline itself), in tree order. */
export function under(n: FindingNode, depth = 1): { finding: Finding; depth: number }[] {
  return n.children.flatMap((c) => [{ finding: c.finding, depth }, ...under(c, depth + 1)])
}

/** "2 errors, 1 warning": how serious the findings under a node are. */
export function severityWords(findings: Finding[]): string {
  const words: [Severity, string][] = [['error', 'error'], ['warning', 'warning'], ['info', 'info']]
  return words
    .map(([s, word]) => [findings.filter((f) => f.severity === s).length, word] as const)
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}${n === 1 || word === 'info' ? '' : 's'}`)
    .join(', ')
}
