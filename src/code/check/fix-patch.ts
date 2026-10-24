/**
 * A fix as a patch: the edits a code rule offers (`CodeProblem.fix`), written as a git-format unified diff the student
 * reads and applies with `git apply` (ADR 2: a fix is a preview; Hindsight never commits, pushes or opens a pull request).
 *
 * Pure: it gets the files' text and reads nothing. Paths are from the top of the repo, so `git apply` works from the
 * folder that holds the repo's .git (the robot folder). Edits are character positions in the file's text.
 */

/** One change to one file: the text from `start` up to `end` becomes `replacement`. */
export interface FixEdit { file: string; start: number; end: number; replacement: string }

/** What a code rule offers for a finding when the edit is mechanical and certain. */
export interface Fix {
  edits: FixEdit[]
  /** What the edit does not settle, in plain words. A fix never goes without it. */
  doesNotFix: string
}

const CONTEXT = 3

/** The unified diff for these edits, files in path order; '' when they change nothing. `texts` maps a path to its text. */
export function patchOf(edits: FixEdit[], texts: ReadonlyMap<string, string>): string {
  const byFile = new Map<string, FixEdit[]>()
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e])
  return [...byFile.keys()].sort().map((file) => filePatch(file, texts.get(file), byFile.get(file)!)).join('')
}

function filePatch(file: string, text: string | undefined, edits: FixEdit[]): string {
  if (text === undefined) throw new Error(`${file}: the text to patch is missing`)
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  sorted.forEach((e, i) => {
    if (e.start < 0 || e.end < e.start || e.end > text.length || (i > 0 && e.start < sorted[i - 1].end)) throw new Error(`${file}: edits overlap or lie outside the file`)
  })
  const lines = text.split('\n')
  const endsWithNewline = lines.at(-1) === ''
  if (endsWithNewline) lines.pop()
  const starts: number[] = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  const lineAt = (position: number) => Math.min(lines.length - 1, Math.max(0, upperBound(starts, position) - 1))

  // Edits on the same line (or touching lines) become one changed block of lines.
  type Block = { first: number; last: number; edits: FixEdit[] }
  const blocks: Block[] = []
  for (const e of sorted) {
    if (e.replacement === text.slice(e.start, e.end)) continue
    const first = lineAt(e.start)
    const last = lineAt(Math.max(e.start, e.end - 1))
    const previous = blocks.at(-1)
    if (previous && first <= previous.last) {
      previous.last = Math.max(previous.last, last)
      previous.edits.push(e)
    } else blocks.push({ first, last, edits: [e] })
  }
  if (!blocks.length) return ''

  // The block's lines after the edits. The range takes in the last line's line end, which an edit may replace.
  const newLines = (b: Block): string[] => {
    const to = Math.min(text.length, starts[b.last] + lines[b.last].length + 1)
    let out = ''
    let pos = starts[b.first]
    for (const e of b.edits) { out += text.slice(pos, e.start) + e.replacement; pos = e.end }
    out += text.slice(pos, to)
    const changed = out.split('\n')
    if (to > starts[b.last] + lines[b.last].length && changed.at(-1) === '') changed.pop()
    return changed
  }

  // Blocks whose context would meet share a hunk.
  const hunks: Block[][] = []
  for (const b of blocks) {
    const h = hunks.at(-1)
    if (h && b.first - h.at(-1)!.last - 1 <= 2 * CONTEXT) h.push(b)
    else hunks.push([b])
  }
  const noNewline = '\\ No newline at end of file'
  const lastIndex = lines.length - 1
  const open = (index: number) => (index === lastIndex && !endsWithNewline ? [noNewline] : [])
  let delta = 0
  const out: string[] = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`]
  for (const h of hunks) {
    const from = Math.max(0, h[0].first - CONTEXT)
    const to = Math.min(lastIndex, h.at(-1)!.last + CONTEXT)
    const body: string[] = []
    let oldCount = 0
    let newCount = 0
    const context = (a: number, b: number) => { for (let i = a; i <= b; i++) { body.push(` ${lines[i]}`, ...open(i)); oldCount++; newCount++ } }
    let next = from
    for (const b of h) {
      context(next, b.first - 1)
      for (let i = b.first; i <= b.last; i++) { body.push(`-${lines[i]}`, ...open(i)); oldCount++ }
      for (const l of newLines(b)) { body.push(`+${l}`); newCount++ }
      if (b.last === lastIndex && !endsWithNewline) body.push(noNewline)
      next = b.last + 1
    }
    context(next, to)
    const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`)
    const oldStart = oldCount === 0 ? from : from + 1
    out.push(`@@ -${range(oldStart, oldCount)} +${range(oldStart + delta, newCount)} @@`, ...body)
    delta += newCount - oldCount
  }
  return out.join('\n') + '\n'
}

/** The first index whose value is greater than x, in a sorted list. */
function upperBound(sorted: number[], x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The patch as a file name for Save: "fix-code-limit-switched-off.patch". */
export const patchFileName = (rule: string) => `fix-${rule.replace(/[^a-z0-9]+/gi, '-')}.patch`

/** The patch's own text with its first lines read: which files it changes, for a one-line label. */
export const filesOfPatch = (patch: string): string[] => [...patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1])

/** The lines a patch removes or changes, as "path:line" in the old file (a removed line whose own text starts with `--` is skipped as a header: unreachable for indented code). */
export function changedLines(patch: string): string[] {
  const out: string[] = []
  let file = ''
  let line = 0
  for (const text of patch.split('\n')) {
    const header = /^diff --git a\/(\S+) b\//.exec(text)
    if (header) { file = header[1]; continue }
    const hunk = /^@@ -(\d+)/.exec(text)
    if (hunk) { line = Number(hunk[1]); continue }
    if (!file || !line || text.startsWith('---') || text.startsWith('+++') || text.startsWith('\\')) continue
    if (text.startsWith('-')) out.push(`${file}:${line++}`)
    else if (text.startsWith(' ')) line++
  }
  return out
}

/** Each hunk's span of old-file lines, context included: `git apply` matches the whole span, so two patches whose spans meet can't both apply as they are. */
export function hunkRanges(patch: string): { file: string; from: number; to: number }[] {
  const out: { file: string; from: number; to: number }[] = []
  let file = ''
  for (const text of patch.split('\n')) {
    const header = /^diff --git a\/(\S+) b\//.exec(text)
    if (header) { file = header[1]; continue }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(text)
    if (hunk && file) { const from = Number(hunk[1]); out.push({ file, from, to: from + Number(hunk[2] ?? 1) - 1 }) }
  }
  return out
}

/** Two fixes that can't both be applied one after the other: a hunk of one overlaps a hunk of the other in the same file. */
export function fixesClash(a: string, b: string): boolean {
  const rb = hunkRanges(b)
  return hunkRanges(a).some((x) => rb.some((y) => x.file === y.file && x.from <= y.to && y.from <= x.to))
}
