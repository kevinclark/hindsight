/**
 * Golden output for refactoring rules: every finding, skip and crash on a set of logs, as stable JSON, so a
 * behaviour-preserving change can be proved by diffing two runs.
 *
 *   node --experimental-strip-types scripts/golden.ts <out.json> <group> [<group> ...] [--code <robot-code folder>]
 *     [--github <owner/repo>[@ref]] [--code-cache <file>]
 *
 * A group is a folder (or a comma-separated list of files): its logs are loaded together, as the app would, so rules
 * that look across logs (restart-mid-match, early-disable) see the same neighbours. Plot data is kept as a
 * count and checksum, not the samples.
 *
 * --code: the robot-code folder (with its .git), so power/limit-not-applied can compare each log's commit with the
 * profile's (src/code/limit-lines.ts). Answers are kept in --code-cache (default ~/.cache/hindsight/limit-lines.json).
 * --github: the same, read from a public GitHub repo instead (src/code/github.ts), its file lists kept in --code-cache
 * too. The comparison reads the profile's commit and each log's, so an @ref is accepted and not needed. The calls it
 * made are printed: the API ones count against GitHub's 60 an hour.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeFilesWithCode } from '../src/analyze.ts'
import { DEFAULT_CACHE, nodeCodeFolder, nodeGitHub } from '../src/code/node-git-dir.ts'
import { parseGitHub } from '../src/code/github.ts'

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, value] = args.splice(i, 2)
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}
const codeDir = option('--code')
const githubSpec = option('--github')
const githubRepo = githubSpec ? parseGitHub(githubSpec)?.repo : undefined
if (githubSpec && !githubRepo) throw new Error(`--github ${githubSpec}: write it as owner/repo or owner/repo@ref`)
if (codeDir && githubSpec) throw new Error('--code and --github: choose one')
const cacheFile = option('--code-cache') ?? DEFAULT_CACHE
const github = githubRepo ? nodeGitHub(githubRepo, cacheFile) : null
const code = codeDir ? nodeCodeFolder(codeDir, cacheFile) : github
const [out, ...groups] = args
const walk = (p: string): string[] =>
  statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((f) => walk(join(p, f))) : /\.(wpilog|dslog)$/.test(p) ? [p] : []

const summary = (_k: string, v: unknown) => {
  if (ArrayBuffer.isView(v)) {
    const a = Array.from(v as Float64Array)
    return { n: a.length, sum: +a.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0).toPrecision(12) }
  }
  return typeof v === 'number' && !Number.isFinite(v) ? String(v) : v
}

const result: Record<string, unknown> = {}
for (const g of groups) {
  const paths = g.split(',').flatMap(walk)
  const { analyses, problems } = await analyzeFilesWithCode(paths.map((p) => ({ name: p.split('/').pop()!, bytes: new Uint8Array(readFileSync(p)) })), code)
  result[g] = {
    problems,
    logs: analyses.map((a) => ({ file: a.match.fileName, profile: a.match.profile?.name ?? null, findings: a.report.findings, skipped: a.report.skipped, crashed: a.report.crashed, ...(a.report.parents ? { parents: a.report.parents } : {}) })),
  }
  console.error(`${g}: ${analyses.length} logs, ${analyses.reduce((n, a) => n + a.report.findings.length, 0)} findings, ${analyses.reduce((n, a) => n + a.report.crashed.length, 0)} crashed`)
}
writeFileSync(out, JSON.stringify(result, summary, 1))
code?.save()
if (github) console.error(`GitHub ${githubRepo}: ${github.repo.calls.api} API calls, ${github.repo.calls.raw} raw reads`)
