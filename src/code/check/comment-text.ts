/**
 * The code check as one pull-request comment (Markdown). The first line is a hidden marker, so the next run finds the
 * comment and edits it instead of adding another. Pure text in, text out. Like the summary, it is context for the team,
 * never a verdict.
 *
 * The look follows ISA-101 (colour only for what is abnormal), WCAG 1.4.1 (never colour alone: every level has an icon
 * and words as well as its box) and NN/g's mobile advice (short blocks, not long lines). GitHub's alert blocks give the
 * colour: CAUTION (red) when the run fails or a check crashed, WARNING (amber) for what the change adds, TIP (green)
 * when nothing is new, NOTE (blue) when nothing could be compared. Older findings are plain, folded, grey.
 */
import type { FailOn } from './cli-options.ts'
import { cell, escapeMarkdown, fileUrl, mentionsInCode, type Linker, type Marked } from './github-format.ts'

/** The hidden first line that says "this comment is the code check's". */
export const MARKER = '<!-- hindsight-code-check -->'

/** At most this many findings are listed (new first), so a big repo can't make a huge comment. */
export const MAX_ROWS = 50

/** Each piece of text in a finding is cut to this many characters: 50 findings stay well below GitHub's 65,536-character cap. */
const MAX_TITLE = 100
const MAX_MESSAGE = 250
const MAX_PATH = 200

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
  /** The fail-on setting, and whether this run fails because of it. */
  failOn: FailOn
  fails: boolean
  /** The ids of the rules that crashed (a bug in Hindsight). */
  crashed: string[]
}

/** True when something changed in this pull request: a new finding, or a fixed one. This is when a comment is worth posting. */
export function hasNews(findings: Marked[], fixed: number | null): boolean {
  return findings.some((f) => f.isNew) || (fixed ?? 0) > 0
}

/** GitHub refuses a comment over 65,536 characters (counted here in bytes, the stricter way); with ordinary text 50 findings take about 15,000. */
const SAFE_LENGTH = 60_000

/** The whole comment. If odd text (very long, all-encoded paths) makes it too long, fewer findings are listed. */
export function commentBody(input: CommentInput): string {
  let rows = MAX_ROWS
  let text = build(input, rows)
  while (Buffer.byteLength(text, 'utf8') > SAFE_LENGTH && rows > 1) {
    rows = Math.floor(rows / 2)
    text = build(input, rows)
  }
  return text
}

/** The comment listing at most `maxRows` findings. */
function build(input: CommentInput, maxRows: number): string {
  const { findings, notCompared } = input
  const news = findings.filter((f) => f.isNew)
  const olds = findings.filter((f) => !f.isNew)
  const shownNews = news.slice(0, maxRows)
  const shownOlds = olds.slice(0, maxRows - shownNews.length)
  const parts = [MARKER, header(input, news.length)]
  parts.push(...cautions(input, news.length))
  if (notCompared) parts.push(box('NOTE', [cell(notCompared)]))
  else if (news.length > 0) parts.push(newBox(shownNews, news, input.link))
  else parts.push(input.fails ? cleanLine(input.fixed) : box('TIP', [cleanLine(input.fixed)]))      // not green next to a red box
  if (shownOlds.length > 0) parts.push(oldFindings(shownOlds, olds, notCompared !== null, input.link))
  const hidden = findings.length - shownNews.length - shownOlds.length
  if (hidden > 0) parts.push(moreLine(hidden, input.runUrl))
  parts.push(footer(input.runUrl))
  return parts.join('\n\n') + '\n'
}

/** `### Code check · 3 new · 1 fixed` ("nothing new" for 0; nothing about fixed when 0; "not compared" when there was no base). */
function header({ fixed, notCompared }: CommentInput, newCount: number): string {
  if (notCompared) return '### Code check · not compared'
  const fixedText = (fixed ?? 0) > 0 ? ` · ${fixed} fixed` : ''
  return `### Code check · ${newCount > 0 ? `${newCount} new` : 'nothing new'}${fixedText}`
}

/** The red boxes: the run fails because of fail-on, and/or a check crashed. Usually none. */
function cautions({ findings, failOn, fails, crashed }: CommentInput, newCount: number): string[] {
  const boxes: string[] = []
  if (fails) {
    const what = failOn === 'new' ? `this change adds ${newCount} ${noun(newCount)}` : `the code has ${findings.length} ${noun(findings.length)}`
    boxes.push(box('CAUTION', [`**This run fails:** fail-on is set to ${failOn} and ${what}.`]))
  }
  if (crashed.length > 0) {
    boxes.push(box('CAUTION', [`**A check crashed** (a bug in Hindsight, not in your code): ${crashed.map(cell).join(', ')}.`]))
  }
  return boxes
}

/** The amber box with what the change adds. */
function newBox(shown: Marked[], all: Marked[], link: Linker): string {
  return box('WARNING', [`**${all.length} new in this change**`, '', ...groupBlocks(shown, all, link)])
}

/** The green line: nothing new, and how many were fixed. */
function cleanLine(fixed: number | null): string {
  return (fixed ?? 0) > 0 ? `**Nothing new in this change.** ${fixed} fixed.` : '**Nothing new in this change.**'
}

/** The older findings, folded away and plain (grey), so they don't crowd the new ones. */
function oldFindings(shown: Marked[], all: Marked[], notCompared: boolean, link: Linker): string {
  const total = all.length
  const summary = `ℹ️ ${total} ${noun(total)}${notCompared ? '' : ' already in the code'}`
  return ['<details>', `<summary>${summary}</summary>`, '', groupBlocks(shown, all, link).join('\n'), '', '</details>'].join('\n')
}

/** A GitHub alert: a quote whose first line names its level, followed by the lines. */
function box(level: 'CAUTION' | 'WARNING' | 'TIP' | 'NOTE', lines: string[]): string {
  return [`> [!${level}]`, ...lines.map((line) => (line === '' ? '>' : `> ${line}`))].join('\n')
}

/** The findings as blocks, one per check (blank lines between them): the sites of one check share a title and next step. */
function groupBlocks(shown: Marked[], all: Marked[], link: Linker): string[] {
  const totals = new Map<string, number>()
  for (const f of all) totals.set(groupKey(f), (totals.get(groupKey(f)) ?? 0) + 1)
  const groups = new Map<string, Marked[]>()
  for (const f of shown) groups.set(groupKey(f), [...(groups.get(groupKey(f)) ?? []), f])
  const blocks = [...groups.entries()].map(([key, sites]) => groupBlock(sites, totals.get(key) ?? sites.length, link))
  return blocks.flatMap((lines, i) => (i === 0 ? lines : ['', ...lines]))
}

/** What makes two findings one block: the same check with the same title and next step. */
const groupKey = (f: Marked) => `${f.rule}\n${f.title}\n${f.nextStep}`

/** One check: its title (and how many places, "50 of 60" when the cap cut some), one line per place, then the next step once. */
function groupBlock(sites: Marked[], total: number, link: Linker): string[] {
  const first = sites[0]
  const count = total === 1 ? '' : sites.length < total ? ` (${sites.length} of ${total})` : ` (${total})`
  const lines = sites.map((f) => `- ${placeOf(f, link)} — ${sentence(clip(f.message, MAX_MESSAGE))}`)
  return [`**${clip(first.title, MAX_TITLE)}**${count}`, ...lines, '', `*Next step:* ${sentence(clip(first.nextStep, MAX_MESSAGE))}`]
}

/** `[File.java:90](link "full/path/File.java")`, or `File.java:90` in code when there is no link (or the path is very long). */
function placeOf(f: Marked, link: Linker): string {
  const name = (f.file.split('/').pop() ?? f.file).replace(/`/g, '')
  const url = f.file.length <= MAX_PATH ? fileUrl(f, link) : null          // a huge path would make a huge link
  if (!url) return `\`${name.slice(0, MAX_PATH)}:${f.line}\``
  return `[${cell(name)}:${f.line}](${url} "${clip(f.file, MAX_PATH).replace(/["\\]/g, '')}")`
}

/** The line that says how many findings are not listed, and where all of them are. */
function moreLine(hidden: number, runUrl: string | null): string {
  const page = runUrl ? `[the run's summary page](${runUrl})` : "the run's summary page"
  return `… and ${hidden} more on ${page}.`
}

/** The small print: what the comment is, and where the whole report is. */
function footer(runUrl: string | null): string {
  const report = runUrl ? ` · [full report](${runUrl})` : ''
  return `<sub>Context for the team, not a verdict on the change or on anyone · Hindsight code check${report}</sub>`
}

const noun = (n: number) => (n === 1 ? 'finding' : 'findings')

/** Safe Markdown, and not longer than `limit` characters (plus a "…"). Cut before @names are put in code, and never mid-entity. */
function clip(text: string, limit: number): string {
  const safe = escapeMarkdown(text)
  if (safe.length <= limit) return mentionsInCode(safe)
  return `${mentionsInCode(safe.slice(0, limit).replace(/&[a-z#0-9]*$|\\$/, ''))}…`
}

/** The text with a full stop at the end, unless it already ends like a sentence. */
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`)
