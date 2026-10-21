/**
 * What changed between two commits of the robot code: which of the head's findings are new, and how many of the base's
 * are gone. Pure: it gets the findings and the files' text, and reads nothing.
 *
 * Two findings are "the same one" when they have the same rule, the same file and the same line of code (its text,
 * trimmed). Not the line number (adding a line above moves every finding below it) and not the message (the duplicate
 * CAN ID message lists the other places with their line numbers, so it changes whenever they move). The cost: a
 * finding whose line is edited, or whose file moved, counts as one new and one fixed.
 */
import type { CodeFinding } from './rule.ts'

/** One commit's findings and the text of its Java files. */
export interface Side {
  findings: CodeFinding[]
  files: { path: string; text: string }[]
}

export interface Comparison {
  /** The head's findings, each marked new (not in the base) or not. */
  findings: (CodeFinding & { isNew: boolean })[]
  /** How many of the base's findings are not in the head. */
  fixed: number
}

export function compareFindings(head: Side, base: Side): Comparison {
  const unmatched = new Map<string, number>()
  for (const key of keysOf(base)) unmatched.set(key, (unmatched.get(key) ?? 0) + 1)
  const keys = keysOf(head)
  const findings = head.findings.map((finding, i) => {
    const left = unmatched.get(keys[i] ?? '') ?? 0
    unmatched.set(keys[i] ?? '', left - 1)       // two identical lines match pairwise: each base finding is used once
    return { ...finding, isNew: left <= 0 }
  })
  const fixed = [...unmatched.values()].reduce((sum, left) => sum + Math.max(left, 0), 0)
  return { findings, fixed }
}

/** Each finding's identity: rule, file and the trimmed text of its line. */
function keysOf(side: Side): string[] {
  const lines = new Map(side.files.map((file) => [file.path, file.text.split('\n')]))
  return side.findings.map((f) => [f.rule, f.file, (lines.get(f.file)?.[f.line - 1] ?? '').trim()].join('\0'))
}
