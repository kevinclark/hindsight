/**
 * The code check in GitHub's formats: workflow-command annotations (`::warning file=…::message`) and the Markdown
 * summary on the run's page. Pure text in, text out. Findings are context for the team, never a verdict, and the
 * wording says so.
 */
import type { CodeFinding } from './rule.ts'

/** A finding, and whether it is new in this change (null: not compared with a base). */
export type Marked = CodeFinding & { isNew: boolean | null }

/** Escapes as actions/toolkit does: the message part of a workflow command. */
export const escapeData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

/** Escapes as actions/toolkit does: a property (file=, title=) of a workflow command. */
export const escapeProperty = (text: string) => escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C')

/** New findings are warnings; the others (old, or not compared) are notices. */
export function annotation(f: Marked): string {
  const level = f.isNew ? 'warning' : 'notice'
  return `::${level} file=${escapeProperty(f.file)},line=${f.line},title=${escapeProperty(`${f.title} (${f.rule})`)}::${escapeData(f.message)}`
}

/** A check that crashed is a Hindsight bug, not a problem in the robot code: a notice, never a failure. */
export const crashNotice = (rule: string, why: string) =>
  `::notice title=${escapeProperty(`Code check rule ${rule} crashed`)}::${escapeData(`${why} (a bug in Hindsight, not in your code)`)}`

/** --exclude-rules named ids that no rule has (a typo would otherwise leave a rule on without a word). */
export const unknownLine = (ids: string[]) => `--exclude-rules: no such rule: ${ids.join(', ')}`

export const unknownNotice = (ids: string[]) => `::notice title=${escapeProperty('Unknown rule in exclude-rules')}::${escapeData(unknownLine(ids))}`

/** Where a finding's file is on GitHub, and whether the line number can be trusted there. */
export interface Linker {
  /** `https://github.com/owner/name/blob/<sha>`, or null when the environment doesn't say. */
  blob: string | null
  /** The files whose text is the same at the linked commit and the checked one: only there the line number holds. */
  sameText: Set<string>
}

/** The counts line: "11 findings, 2 new in this change, 1 fixed". */
export function countsLine(findings: Marked[], fixed: number | null): string {
  const news = findings.filter((f) => f.isNew).length
  const count = `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`
  return fixed === null ? count : `${count}, ${news} new in this change, ${fixed} fixed`
}

/** The Markdown for $GITHUB_STEP_SUMMARY. `notCompared` says why nothing was compared, when that is so. */
export function summary(findings: Marked[], fixed: number | null, link: Linker, notCompared: string | null): string {
  const lines = ['### Code check', '', `${countsLine(findings, fixed)}.`]
  lines.push('', "These are things worth a look, found by reading the code. They are context for the team, not a verdict on the change or on anyone.")
  if (notCompared) lines.push('', notCompared)
  if (findings.length === 0) return lines.join('\n') + '\n'
  lines.push('', '| New? | Check | Where | What it found | Next step |', '| --- | --- | --- | --- | --- |')
  for (const f of findings) {
    const isNew = f.isNew === null ? 'not compared' : f.isNew ? 'new' : ''
    lines.push(`| ${isNew} | ${cell(f.title)} | ${where(f, link)} | ${cell(f.message)} | ${cell(f.nextStep)} |`)
  }
  return lines.join('\n') + '\n'
}

/** `file:line`, linked to the file on GitHub (to the line too, when the line number holds there). */
function where(f: Marked, link: Linker): string {
  const text = `\`${f.file.replace(/`/g, '')}:${f.line}\``
  if (!link.blob) return text
  const anchor = link.sameText.has(f.file) ? `#L${f.line}` : ''
  return `[${text}](${link.blob}/${f.file.split('/').map(encodeURIComponent).join('/')}${anchor})`
}

/** Text safe inside a Markdown table cell: no HTML, no emphasis or code from the code's own characters, one line. */
const cell = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\|`*_[\]]/g, '\\$&').replace(/\s*\n\s*/g, ' ')
