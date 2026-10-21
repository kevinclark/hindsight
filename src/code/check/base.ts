/** The code check at a second commit (the base), for comparing: what it found, or why it couldn't be read. */
import { GitUnreadable } from '../git.ts'
import { javaFilesAt, type CodeSource } from '../source.ts'
import type { Side } from './compare.ts'
import { checkCode } from './index.ts'
import type { CodeReport } from './rule.ts'

/** Leaves out the findings and crashes of these rules. */
export function without(report: CodeReport, excluded: string[]): CodeReport {
  return {
    ...report,
    findings: report.findings.filter((f) => !excluded.includes(f.rule)),
    crashed: report.crashed.filter((c) => !excluded.includes(c.rule)),
  }
}

/** The base commit's findings and files; `why` when it can't be read (a shallow clone without it, a wrong hash). */
export async function readBase(source: CodeSource, ref: string, excluded: string[]): Promise<{ commit: string; side: Side } | { why: string }> {
  try {
    const commit = await source.resolve(ref)
    const files = await javaFilesAt(source, commit)
    return { commit, side: { findings: without(checkCode(files), excluded).findings, files } }
  } catch (error) {
    if (!(error instanceof GitUnreadable)) throw error
    return { why: error.message }
  }
}
