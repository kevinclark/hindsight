/**
 * The code check from the command line, for a laptop or a team's CI (their choice): reads a robot-code folder's .git
 * and prints each finding. Exits 1 when there are findings, 2 when it couldn't read the folder.
 *
 *   node --experimental-strip-types scripts/code-check.ts <folder> [commit]     # default: the folder's HEAD
 *   node --experimental-strip-types scripts/code-check.ts --tree <folder> File.java:50   # the tree of one line
 *
 * Read only: nothing in the folder is changed.
 */
import { GitRepo } from '../src/code/git.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { checkCode, javaFilesAt } from '../src/code/check/index.ts'
import { lineOf, parseJava, type Node } from '../src/code/check/java.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'

const args = process.argv.slice(2)
const showTree = args[0] === '--tree'
const [folder, wanted] = showTree ? args.slice(1) : args
const dir = folder ? nodeGitDir(folder) : null
if (!dir) {
  console.error('usage: code-check.ts <robot-code folder> [commit]  |  code-check.ts --tree <folder> File.java:50')
  process.exit(2)
}
await loadJavaFromDisk()
const repo = new GitRepo(dir)
const head = await repo.head()
const commit = showTree || !wanted ? head.sha : await repo.resolve(wanted)
const files = await javaFilesAt(repo, commit)

if (showTree) {
  const [name, line] = (wanted ?? '').split(':')
  const file = files.find((f) => f.path === name || f.path.endsWith(`/${name}`))
  if (!file) throw new Error(`no ${name} in ${commit.slice(0, 7)}`)
  const tree = parseJava(file.path, file.text).tree
  printLine(tree.rootNode, Number(line))
  tree.delete()
} else {
  const report = checkCode(files)
  console.log(`${files.length} Java files at ${commit.slice(0, 7)}${head.branch && commit === head.sha ? ` (${head.branch})` : ''}`)
  for (const f of report.findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.message}`)
  console.log(`${report.findings.length} findings; ${report.notJudged.length} places it couldn't judge`)
  for (const c of report.crashed) console.log(`CRASHED ${c.rule}: ${c.why}`)
  process.exitCode = report.findings.length || report.crashed.length ? 1 : 0
}

/** The largest pieces of code that start on this line, as tree-sitter sees them. */
function printLine(node: Node, line: number): void {
  if (lineOf(node) === line) return console.log(node.toString())
  for (const child of node.namedChildren) if (child) printLine(child, line)
}
