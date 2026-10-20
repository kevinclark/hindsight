/**
 * The code check's evidence gate: no rule ships without it.
 *
 *   node --experimental-strip-types scripts/code-check-backtest.ts <team-repos-dir> [<public-repos-dir> <public-list.json>]
 *
 * Reads read-only clones (each repo's folder named as in scripts/code-check-cases.json) and checks:
 * - **Recall**: for each bug fix in a rule's class (`history`), did the rule fire on the fix's parent, in that file
 *   within 2 lines of the bug, and did the fix clear it (fewer of that rule's findings in the file)? For each bug still
 *   in the code (`live`), does it fire there? Each case says what is expected, so a known miss is written down and a
 *   change in either direction fails.
 * - **False hits**: every finding at the pinned heads (`heads`) must be in the reviewed list (`reviewed`), marked real
 *   or false with why. A finding nobody has read fails; so does a false one from a rule that ships.
 * Public repos work the same way, but their reviewed list lives outside this repo (it names other teams' code).
 * It also checks the parser finds every `new TalonFX` the profile builder's regex (code-hints.ts) finds.
 * Prints every case and a final PASS or FAIL; exits 1 on FAIL.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitRepo } from '../src/code/git.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { CODE_RULES, checkCode, javaFilesAt } from '../src/code/check/index.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'
import type { CodeFinding } from '../src/code/check/rule.ts'
import { Project } from '../src/code/check/project.ts'
import { lineOf, typeNamed } from '../src/code/check/java.ts'
import { codeHead, codeHints } from '../src/builder/code-hints.ts'

/** How far (lines) a finding may sit from the line the history names: fixes move code a little. */
const NEAR_LINES = 2

interface Case { repo: string; commit: string; rule: string; file: string; lines: number[]; expect: 'fires' | 'misses'; why?: string }
interface Reviewed { repo: string; file: string; line: number; rule: string; verdict: 'real' | 'false'; why: string }
interface Cases { history: Case[]; live: Case[]; heads: Record<string, string>; reviewed: Reviewed[] }

const [teamDir, publicDir, publicListPath] = process.argv.slice(2)
if (!teamDir) throw new Error('usage: code-check-backtest.ts <team-repos-dir> [<public-repos-dir> <public-list.json>]')
const cases: Cases = JSON.parse(readFileSync(new URL('code-check-cases.json', import.meta.url), 'utf8'))
const shipped = new Set(CODE_RULES.map((r) => r.id))
const failures: string[] = []
const repos = new Map<string, GitRepo>()
await loadJavaFromDisk()
const sameFile = (f: CodeFinding, name: string) => f.file === name || f.file.endsWith(`/${name}`)

console.log('== Recall: bug fixes (fires on the parent, cleared by the fix)')
const recall = new Map<string, { fired: number; cases: number }>()
for (const c of cases.history) {
  const repo = repoAt(teamDir, c.repo)
  const fix = await repo.resolve(c.commit)
  const before = (await findingsAt(repo, await parentOf(repo, fix))).filter((f) => f.rule === c.rule && sameFile(f, c.file))
  const after = (await findingsAt(repo, fix)).filter((f) => f.rule === c.rule && sameFile(f, c.file))
  const fired = before.some((f) => c.lines.some((l) => Math.abs(f.line - l) <= NEAR_LINES)) && after.length < before.length
  report(c, fired, `${c.repo} ${c.commit} ${c.file}:${c.lines.join(',')}`)
}
console.log('== Recall: bugs still in the code')
for (const c of cases.live) {
  const found = (await findingsAt(repoAt(teamDir, c.repo), c.commit)).filter((f) => f.rule === c.rule && sameFile(f, c.file))
  const fired = c.lines.every((l) => found.some((f) => Math.abs(f.line - l) <= NEAR_LINES))
  report(c, fired, `${c.repo} ${c.commit} ${c.file}:${c.lines.join(',')}`)
}
for (const [rule, r] of recall) console.log(`recall ${rule}: ${r.fired}/${r.cases}`)

console.log('== The parser sees every TalonFX the profile builder\'s code hints see (src/builder/code-hints.ts)')
for (const [name, commit] of Object.entries(cases.heads)) {
  const repo = repoAt(teamDir, name)
  const files = await javaFilesAt(repo, await repo.resolve(commit))
  const project = new Project(files)
  const parsed = new Set(project.nodes('object_creation_expression').filter((n) => typeNamed(n) === 'TalonFX').map((n) => `${project.fileOf(n).path}:${lineOf(n)}`))
  project.close()
  const hinted = codeHints(files, await codeHead(repo)).sites
  const missed = hinted.filter((s) => !parsed.has(`${s.file}:${s.line}`))
  for (const s of missed) failures.push(`${name}: code-hints sees TalonFX at ${s.file}:${s.line}, the parser doesn't`)
  console.log(`  ${name}: ${hinted.length} by code-hints, ${parsed.size} by the parser, ${missed.length} only by code-hints`)
}

console.log('== Findings at the team heads')
await readHeads(teamDir, cases.heads, cases.reviewed)
if (publicDir && publicListPath) {
  console.log('== Findings at the public heads')
  const list: { heads: Record<string, string>; reviewed: Reviewed[] } = JSON.parse(readFileSync(publicListPath, 'utf8'))
  await readHeads(publicDir, list.heads, list.reviewed)
}

console.log(failures.length ? `FAIL: ${failures.length}\n  ${failures.join('\n  ')}` : 'PASS')
process.exitCode = failures.length ? 1 : 0

/** Every finding at the pinned head of each repo, each matched with its reviewed verdict. */
async function readHeads(dir: string, heads: Record<string, string>, reviewed: Reviewed[]): Promise<void> {
  const tally = new Map<string, { real: number; false: number }>()
  for (const [name, commit] of Object.entries(heads)) {
    for (const f of await findingsAt(repoAt(dir, name), commit)) {
      const verdict = reviewed.find((r) => r.repo === name && r.rule === f.rule && r.line === f.line && sameFile(f, r.file))
      const where = `${name} ${f.file.split('/').pop()}:${f.line} ${f.rule}`
      if (!verdict) failures.push(`not reviewed: ${where}: ${f.message}`)
      else if (verdict.verdict === 'false' && shipped.has(f.rule)) failures.push(`false hit from a shipped rule: ${where}: ${verdict.why}`)
      const counts = tally.get(f.rule) ?? { real: 0, false: 0 }
      if (verdict) counts[verdict.verdict]++
      tally.set(f.rule, counts)
      console.log(`  ${verdict?.verdict ?? 'UNREVIEWED'}  ${where}  ${f.message}`)
    }
  }
  for (const [rule, t] of tally) console.log(`hits ${rule}: ${t.real} real, ${t.false} false`)
}

function report(c: Case, fired: boolean, where: string): void {
  const r = recall.get(c.rule) ?? { fired: 0, cases: 0 }
  recall.set(c.rule, { fired: r.fired + (fired ? 1 : 0), cases: r.cases + 1 })
  const expected = (c.expect === 'fires') === fired
  if (!expected) failures.push(`${c.rule} ${where}: expected it to ${c.expect === 'fires' ? 'fire' : 'miss'}`)
  console.log(`  ${fired ? 'fired ' : 'missed'} ${c.rule}  ${where}${c.why ? `  (${c.why})` : ''}${expected ? '' : '  UNEXPECTED'}`)
}

function repoAt(dir: string, name: string): GitRepo {
  const path = join(dir, name)
  const known = repos.get(path)
  if (known) return known
  const gitDir = nodeGitDir(path)
  if (!gitDir) throw new Error(`no clone of ${name} in ${dir}`)
  const repo = new GitRepo(gitDir)
  repos.set(path, repo)
  return repo
}

async function findingsAt(repo: GitRepo, commit: string): Promise<CodeFinding[]> {
  const report = checkCode(await javaFilesAt(repo, await repo.resolve(commit)))
  for (const c of report.crashed) failures.push(`${c.rule} crashed at ${commit.slice(0, 7)}: ${c.why}`)
  return report.findings
}

async function parentOf(repo: GitRepo, commit: string): Promise<string> {
  const text = new TextDecoder().decode((await repo.object(commit)).data)
  const parent = /^parent ([0-9a-f]{40})$/m.exec(text)?.[1]
  if (!parent) throw new Error(`${commit.slice(0, 7)} has no parent`)
  return parent
}

