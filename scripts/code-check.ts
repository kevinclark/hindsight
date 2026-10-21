/**
 * The code check from the command line, for a laptop or a team's CI (their choice): reads a robot-code folder's .git
 * and prints each finding. Exits 1 when there are findings (see --fail-on), 2 when it couldn't read the folder.
 *
 *   node --experimental-strip-types scripts/code-check.ts <folder> [commit]     # default: the folder's HEAD
 *   node --experimental-strip-types scripts/code-check.ts --tree <folder> File.java:50   # the tree of one line
 *
 * Comparing with an earlier commit (what is new in a change):
 *   --base <commit>          mark each finding new or not, and count the base's findings that are gone
 *   --fail-on none|new|any   when to exit 1: never, on a new finding (needs a readable base), on any (the default)
 *   --exclude-rules a,b      leave these rules out, e.g. code/integer-division when the compiler already checks it
 *   --github                 GitHub annotations, a step summary ($GITHUB_STEP_SUMMARY) and outputs ($GITHUB_OUTPUT)
 *
 * A check that crashes (a bug in Hindsight, not in your code) is printed but never changes the exit code.
 * Read only: nothing in the folder is changed.
 */
import { appendFileSync } from 'node:fs'
import { GitRepo, GitUnreadable, type GitDir } from '../src/code/git.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { CODE_RULES, checkCode } from '../src/code/check/index.ts'
import { readBase, without } from '../src/code/check/base.ts'
import { parseOptions, USAGE, type Options } from '../src/code/check/cli-options.ts'
import { compareFindings } from '../src/code/check/compare.ts'
import { annotation, countsLine, crashNotice, summary, unknownLine, unknownNotice, type Marked } from '../src/code/check/github-format.ts'
import { linkerFor } from '../src/code/check/head-links.ts'
import { javaFilesAt } from '../src/code/source.ts'
import { lineOf, parseJava, type Node } from '../src/code/check/java.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'

const parsed = parseOptions(process.argv.slice(2))
if (typeof parsed === 'string') stop(parsed, true)
const options = parsed as Options
const dir = options.folder ? nodeGitDir(options.folder) : null
if (!dir) stop(options.folder ? `${options.folder} has no .git folder` : 'no folder given', true)
await loadJavaFromDisk()
const repo = new GitRepo(dir as GitDir)
const { head, commit, files } = await readHead(repo, options).catch((error) => {
  if (error instanceof GitUnreadable) return stop(error.message)      // no commits yet, a wrong commit, a damaged .git
  throw error
})

if (options.tree) {
  const [name, line] = (options.wanted ?? '').split(':')
  if (!name || !Number(line)) throw new Error('usage: code-check.ts --tree <folder> File.java:50')
  const file = files.find((f) => f.path === name || f.path.endsWith(`/${name}`))
  if (!file) throw new Error(`no ${name} in ${commit.slice(0, 7)}`)
  const tree = parseJava(file.path, file.text).tree
  printLine(tree.rootNode, Number(line))
  tree.delete()
} else {
  await checkAndPrint(options)
}

/** What the checked folder's HEAD is, the commit to check, and its Java files. */
async function readHead(repo: GitRepo, options: Options) {
  const head = await repo.head()
  const commit = options.tree || !options.wanted ? head.sha : await repo.resolve(options.wanted)
  return { head, commit, files: await javaFilesAt(repo, commit) }
}

/** Says what is wrong (and how to call the script) and exits 2. */
function stop(message: string, showUsage = false): never {
  console.error(message)
  if (showUsage) console.error(USAGE)
  process.exit(2)
}

async function checkAndPrint(options: Options): Promise<void> {
  const report = without(checkCode(files), options.excluded)
  const base = options.base ? await readBase(repo, options.base, options.excluded) : null
  // A rule that crashed on either side is left out of the comparison (marked null, not counted as fixed).
  const skipped = [...report.crashed.map((c) => c.rule), ...(base && 'side' in base ? base.crashed : [])]
  const compared = base && 'side' in base ? compareFindings({ findings: report.findings, files }, base.side, skipped) : null
  const findings: Marked[] = compared ? compared.findings : report.findings.map((f) => ({ ...f, isNew: null }))
  const fixed = compared ? compared.fixed : null
  const baseNote = comparisonNote(options.base, base, findings, fixed)

  console.log(`${files.length} Java files at ${commit.slice(0, 7)}${head.branch && commit === head.sha ? ` (${head.branch})` : ''}`)
  for (const f of findings) console.log(options.github ? annotation(f) : `${f.file}:${f.line}  ${f.rule}  ${f.message}${f.isNew ? '  [new]' : ''}`)
  console.log(`${findings.length} findings; ${report.notJudged.length} places it couldn't judge`)
  if (baseNote) console.log(baseNote)
  const unknown = options.excluded.filter((id) => !CODE_RULES.some((rule) => rule.id === id))
  if (unknown.length) console.log(options.github ? unknownNotice(unknown) : unknownLine(unknown))
  for (const c of report.crashed) console.log(options.github ? crashNotice(c.rule, c.why) : `CRASHED ${c.rule}: ${c.why}`)
  if (options.github) await writeForGitHub(findings, fixed, base && 'why' in base ? baseNote : null)
  process.exitCode = shouldFail(options, findings, compared !== null) ? 1 : 0
}

/** The line about the comparison: how many are new and fixed, or why nothing was compared. Null when no --base. */
function comparisonNote(ref: string | undefined, base: Awaited<ReturnType<typeof readBase>> | null, findings: Marked[], fixed: number | null): string | null {
  if (!ref || !base) return null
  if ('why' in base) return `Not compared with ${ref.slice(0, 7)}: ${base.why}`
  return `Compared with ${base.commit.slice(0, 7)}: ${countsLine(findings, fixed)}`
}

/** `new` never fails without a readable base: a tool or fetch problem must not block anyone. */
function shouldFail(options: Options, findings: Marked[], compared: boolean): boolean {
  if (options.failOn === 'any') return findings.length > 0
  if (options.failOn === 'new') return compared && findings.some((f) => f.isNew)
  return false
}

/** The run's summary page and the step's outputs, when GitHub gave files for them. */
async function writeForGitHub(findings: Marked[], fixed: number | null, notCompared: string | null): Promise<void> {
  const link = await linkerFor(repo, commit, process.env.CODE_CHECK_HEAD_SHA || commit, process.env)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(findings, fixed, link, notCompared))
  const outputs = { findings: findings.length, new: findings.filter((f) => f.isNew).length, fixed: fixed ?? 0, compared: fixed !== null }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''))
}

/** The largest pieces of code that start on this line, as tree-sitter sees them. */
function printLine(node: Node, line: number): void {
  if (lineOf(node) === line) return console.log(node.toString())
  for (const child of node.namedChildren) if (child) printLine(child, line)
}
