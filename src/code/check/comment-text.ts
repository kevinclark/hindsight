/**
 * The code check as one pull-request comment (Markdown). The first line is a hidden marker, so the next run finds the
 * comment and edits it instead of adding another. Pure text in, text out. Like the summary, it is context for the team,
 * never a verdict.
 */
import { cell, countsLine, where, type Linker, type Marked } from './github-format.ts'

/** The hidden first line that says "this comment is the code check's". */
export const MARKER = '<!-- hindsight-code-check -->'

/** At most this many findings are listed (new first), so a big repo can't make a huge comment. */
export const MAX_ROWS = 50

/** Each piece of text in a row is cut to this many characters: 50 rows stay well below GitHub's 65,536-character cap. */
const MAX_TITLE = 100
const MAX_MESSAGE = 250

/** What the comment is about: the findings, the fixed count, and where to find the rest. */
export interface CommentInput {
  findings: Marked[]
  /** How many of the base's findings are gone, or null when nothing was compared. */
  fixed: number | null
  link: Linker
  /** Why nothing was compared, or null when it was. */
  notCompared: string | null
  /** The run's page on GitHub, or null when the environment doesn't say. */
  runUrl: string | null
}

/** True when something changed in this pull request: a new finding, or a fixed one. This is when a comment is worth posting. */
export function hasNews(findings: Marked[], fixed: number | null): boolean {
  return findings.some((f) => f.isNew) || (fixed ?? 0) > 0
}

/** The whole comment. */
export function commentBody(input: CommentInput): string {
  const { findings, fixed, notCompared } = input
  const news = findings.filter((f) => f.isNew)
  const olds = findings.filter((f) => !f.isNew)
  const shownNews = news.slice(0, MAX_ROWS)
  const shownOlds = olds.slice(0, MAX_ROWS - shownNews.length)
  const lines = [MARKER, '### Code check', '']
  lines.push(...leadLines(input, news.length))
  lines.push('', 'These are things worth a look, found by reading the code. They are context for the team, not a verdict on the change or on anyone.')
  if (shownNews.length > 0) lines.push('', ...shownNews.map((f) => row(f, input.link)))
  if (olds.length > 0) lines.push('', ...oldFindings(shownOlds, olds.length, notCompared !== null, input.link))
  const hidden = findings.length - shownNews.length - shownOlds.length
  if (hidden > 0) lines.push('', moreLine(hidden, input.runUrl))
  return lines.join('\n') + '\n'
}

/** The lead: how many are new, how many fixed; or why nothing was compared. */
function leadLines({ findings, fixed, notCompared }: CommentInput, newCount: number): string[] {
  if (notCompared) return [notCompared, '', `${countsLine(findings, null)}, all listed below.`]
  const fixedText = (fixed ?? 0) > 0 ? `${fixed} fixed` : null
  if (newCount === 0) return [fixedText ? `Nothing new in this change. ${fixedText}.` : 'Nothing new in this change.']
  return [fixedText ? `${newCount} new in this change, ${fixedText}:` : `${newCount} new in this change:`]
}

/** The older findings, folded away so they don't crowd the new ones. */
function oldFindings(shown: Marked[], total: number, notCompared: boolean, link: Linker): string[] {
  const noun = total === 1 ? 'finding' : 'findings'
  const summary = notCompared ? `${total} ${noun}` : `${total} ${noun} already in the code`
  return ['<details>', `<summary>${summary}</summary>`, '', ...shown.map((f) => row(f, link)), '', '</details>']
}

/** One finding: the check's name, where it is, what it found, and the next step. */
function row(f: Marked, link: Linker): string {
  return `- **${clip(f.title, MAX_TITLE)}** at ${where(f, link)}: ${sentence(clip(f.message, MAX_MESSAGE))} Next step: ${clip(f.nextStep, MAX_MESSAGE)}`
}

/** The line that says how many findings are not listed, and where all of them are. */
function moreLine(hidden: number, runUrl: string | null): string {
  const page = runUrl ? `[the run's summary page](${runUrl})` : "the run's summary page"
  return `… and ${hidden} more on ${page}.`
}

/** Safe Markdown, and not longer than `limit` characters (plus a "…"). */
function clip(text: string, limit: number): string {
  const safe = cell(text)
  return safe.length <= limit ? safe : `${safe.slice(0, limit)}…`
}

/** The text with a full stop at the end, unless it already ends like a sentence. */
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)
