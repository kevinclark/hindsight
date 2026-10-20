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

/**
 * The list with the parents from the reduce stage (src/rules/parents.ts) put in, each just before the first finding
 * of its group that is in the list. A parent with none of its group in the list is left out.
 */
export function withParents(list: Finding[], parents: Finding[] = []): Finding[] {
  const parentOf = (f: Finding) => parents.find((p) => f.explainedBy?.rule === p.rule && f.explainedBy.about === p.about && f.explainedBy.time === p.time)
  const out: Finding[] = []
  for (const f of list) {
    const p = parentOf(f)
    if (p && !out.includes(p)) out.push(p)
    out.push(f)
  }
  return out
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

/**
 * Splits the top-level nodes for the Match tab's fold: a node folds only when its headline and every finding under it
 * are standing (`standing`: issue keys that fired in every match of the session) and none of them came back after a
 * fix. Otherwise the node stays listed with all it explains, so a one-off finding is never folded away with a
 * standing cause. Order within each side is kept. `parents`: the parents in the tree (they count as standing).
 */
export function partitionStanding(tree: FindingNode[], standing: Set<string>, cameBack: Finding[] = [], parents: Finding[] = []): { listed: FindingNode[]; folded: FindingNode[] } {
  const listed: FindingNode[] = []
  const folded: FindingNode[] = []
  for (const n of tree) {
    // A parent is never in a session's history (it isn't counted): it is standing when its group is.
    const whole = [n.finding, ...descendants(n)].filter((f) => !parents.includes(f))
    const folds = whole.length > 0 && whole.every((f) => standing.has(f.key) && !cameBack.includes(f))
    ;(folds ? folded : listed).push(n)
  }
  return { listed, folded }
}
