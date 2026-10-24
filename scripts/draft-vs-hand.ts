/**
 * Would a draft from code do what a hand profile does? Every log a built-in profile names is analysed twice: with that
 * profile, and with the builder's draft from the log plus the robot code at the commit the log ran (the draft renamed
 * to the hand profile's name, so titles compare). Neither run reads code for limit lines. Read only.
 *
 *   node --experimental-strip-types scripts/draft-vs-hand.ts <library folder> <clones folder> [<out.json>]
 *
 * <library folder> holds manifests/ and logs/ (the hub's library). <clones folder> holds a clone of each profile's
 * repo under its name (`git clone https://github.com/<owner>/<name>`). Day folders are analysed together, with their DS
 * files, as the app does. Prints per log whether the match window (match start, teleop start, match end) is the same
 * in both runs, and per rule how many findings only one run has (by rule, severity and time to 0.1 s), and which
 * rules only one run could check.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { Catalog, type Entry } from '../src/hub/catalog.ts'
import { analyzeFiles, type Analysis } from '../src/analyze.ts'
import { PROFILES, profileId } from '../src/profiles/index.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { draftProfile } from '../src/builder/draft.ts'
import { toProfile } from '../src/builder/json.ts'
import { codeHints, type CodeHints } from '../src/builder/code-hints.ts'
import { GitRepo } from '../src/code/git.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { javaFilesAt } from '../src/code/source.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'

const [lib, clones, out] = process.argv.slice(2)
if (!lib || !clones) throw new Error('usage: draft-vs-hand.ts <library folder> <clones folder> [<out.json>]')
const catalog = Catalog.from(readdirSync(`${lib}/manifests`).map((f) => readFileSync(`${lib}/manifests/${f}`, 'utf8')))
const byId = new Map(PROFILES.map((p) => [profileId(p), p]))
const handOf = (e: Entry) => byId.get(e.record.robot?.profileId ?? '')
const days = new Map<string, Entry[]>()
for (const e of catalog.entries().filter((e) => !e.record.stub && handOf(e))) {
  const day = e.record.path.split('/').slice(0, -1).join('/')
  days.set(day, [...(days.get(day) ?? []), e])
}
await loadJavaFromDisk()

const repos = new Map<string, GitRepo>()
const hints = new Map<string, CodeHints>()
/** The code at the commit a log ran, from the clone of its hand profile's repo; why not, when it can't be read. */
async function hintsAt(hand: RobotProfile, sha: string | undefined): Promise<CodeHints | string> {
  if (!sha) return 'the log names no commit'
  const name = hand.code.repo.split('/')[1]
  if (!repos.has(name)) {
    const dir = nodeGitDir(`${clones}/${name}`)
    if (!dir) return `no clone of ${hand.code.repo} in ${clones}`
    repos.set(name, new GitRepo(dir))
  }
  const repo = repos.get(name)!
  let full: string
  try { full = await repo.resolve(sha) } catch { return `commit ${sha} is not in ${name}` }
  if (!hints.has(full)) hints.set(full, codeHints(await javaFilesAt(repo, full), { sha: full, branch: null }))
  return hints.get(full)!
}

const slim = (a: Analysis) => ({
  window: [a.match.matchStart, a.match.teleopStart, a.match.matchEnd],
  misfit: !!a.match.profileChoice?.misfit,
  findings: a.report.findings.map((f) => ({ rule: f.rule, severity: f.severity, time: f.time === null ? null : Math.round(f.time * 10) / 10, title: f.title })),
  skipped: a.report.skipped.map((s) => s.rule),
})
type Slim = ReturnType<typeof slim>
const logs: { path: string; hand: Slim; draft: Slim | null; why?: string }[] = []
for (const [day, rows] of days) {
  const files: { name: string; bytes: Uint8Array }[] = []
  const hand = new Map<string, RobotProfile>(), draft = new Map<string, RobotProfile>(), why = new Map<string, string>()
  for (const e of rows) {
    const name = e.record.path.split('/').pop()!
    const bytes = new Uint8Array(readFileSync(`${lib}/${e.record.path}`))
    files.push({ name, bytes })
    for (const ds of [...e.attached.dslog, ...e.attached.dsevents]) files.push({ name: ds.path.split('/').pop()!, bytes: new Uint8Array(readFileSync(`${lib}/${ds.path}`)) })
    const h = handOf(e)!
    hand.set(name, h)
    const code = await hintsAt(h, e.record.build?.sha)
    if (typeof code === 'string') { why.set(name, code); continue }
    draft.set(name, { ...toProfile(draftProfile({ logs: [{ log: openWpilog(bytes), fileName: name }], hints: code }).json), name: h.name })
  }
  const withHand = analyzeFiles(files, (f) => hand.get(f)).analyses
  const withDraft = new Map(analyzeFiles(files, (f) => draft.get(f) ?? hand.get(f)).analyses.map((a) => [a.match.fileName, a]))
  for (const a of withHand) {
    const name = a.match.fileName
    logs.push({ path: `${day}/${name}`, hand: slim(a), draft: draft.has(name) ? slim(withDraft.get(name)!) : null, ...(why.has(name) ? { why: why.get(name) } : {}) })
  }
  console.error(`${day}: ${rows.length} logs`)
}
if (out) writeFileSync(out, JSON.stringify(logs))

const compared = logs.filter((l) => l.draft)
const sameWindow = compared.filter((l) => JSON.stringify(l.hand.window) === JSON.stringify(l.draft!.window))
console.log(`${logs.length} logs, ${compared.length} drafted, ${hints.size} commits read; not drafted: ${logs.length - compared.length}`)
for (const [w, n] of count(logs.filter((l) => !l.draft).map((l) => l.why!))) console.log(`  ${n} ${w}`)
console.log(`match window the same: ${sameWindow.length} of ${compared.length}`)
for (const l of compared.filter((l) => !sameWindow.includes(l)).slice(0, 10)) console.log(`  differs: ${l.path} hand ${JSON.stringify(l.hand.window)} draft ${JSON.stringify(l.draft!.window)}`)
const key = (f: Slim['findings'][number]) => `${f.rule}\u0000${f.severity}\u0000${f.time}`
const only = (a: Slim, b: Slim) => { const left = count(b.findings.map(key)); return a.findings.filter((f) => { const n = left.get(key(f)) ?? 0; if (n) { left.set(key(f), n - 1); return false } return true }) }
const report = (title: string, rows: string[]) => { console.log(title); for (const [r, n] of [...count(rows)].sort((a, b) => b[1] - a[1])) console.log(`  ${n} ${r}`) }
report('findings only with the hand profile, by rule:', compared.flatMap((l) => only(l.hand, l.draft!).map((f) => f.rule)))
report('findings only with the draft, by rule:', compared.flatMap((l) => only(l.draft!, l.hand).map((f) => f.rule)))
report('not checked only with the draft (logs):', compared.flatMap((l) => l.draft!.skipped.filter((r) => !l.hand.skipped.includes(r))))
report('not checked only with the hand profile (logs):', compared.flatMap((l) => l.hand.skipped.filter((r) => !l.draft!.skipped.includes(r))))
console.log(`findings: hand ${compared.reduce((n, l) => n + l.hand.findings.length, 0)}, draft ${compared.reduce((n, l) => n + l.draft!.findings.length, 0)}`)

function count(xs: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}
