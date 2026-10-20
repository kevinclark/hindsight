// src/code/git.ts against `git show <sha>:<path>`: a small repo built here with git in three layouts (loose objects, a
// pack with OFS_DELTA objects, a pack with REF_DELTA objects), and optionally a real one:
//   HINDSIGHT_GIT_REPO=<a clone> npx vitest run tests/git-reader.test.ts
// checks every Java file at the newest 40 commits of every branch of that clone, and the delta-heaviest blobs.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { GitRepo, GitUnreadable } from '../src/code/git.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
const gitBytes = (dir: string, ...args: string[]) => new Uint8Array(execFileSync('git', ['-C', dir, ...args], { maxBuffer: 1 << 28 }))
const repoAt = (dir: string) => new GitRepo(nodeGitDir(dir)!)

const made: string[] = []
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

/** A repo with 30 commits that each change a few lines of two long Java files (good delta material). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hindsight-git-'))
  made.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'commit.gpgsign', 'false')
  execFileSync('mkdir', ['-p', join(dir, 'src/main/java/frc/robot/subsystems/indexer')])
  for (let c = 0; c < 30; c++) {
    const lines = Array.from({ length: 400 }, (_, i) => `    config.Line${i} = ${i === 123 ? c % 3 : i};`)
    lines.splice(200, 0, `    config.CurrentLimits.StatorCurrentLimitEnable = ${c % 2 === 0};`)
    writeFileSync(join(dir, 'src/main/java/frc/robot/subsystems/indexer/SpindexerSubsystem.java'), `class Spindexer {\n${lines.join('\n')}\n}\n`)
    writeFileSync(join(dir, `Notes${c % 4}.md`), `note ${c}\n`.repeat(50 + c))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', `commit ${c}`)
  }
  return dir
}

/** Each file at each commit, read both ways: one `git show sha:a sha:b …` per commit (it prints them back to back). */
async function expectSameAsGit(dir: string, commits: string[], paths: (sha: string) => string[]) {
  const repo = repoAt(dir)
  let checked = 0
  for (const sha of commits) {
    const files = paths(sha)
    const want = git(dir, 'show', ...files.map((p) => `${sha}:${p}`))
    const got = (await Promise.all(files.map((p) => repo.textAt(sha, p)))).join('')
    if (got !== want) for (const p of files) expect(await repo.textAt(sha, p), `${sha.slice(0, 7)}:${p}`).toBe(git(dir, 'show', `${sha}:${p}`))
    expect(got, sha.slice(0, 7)).toBe(want)
    checked += files.length
  }
  return checked
}

describe('git reader on a repo built here', () => {
  const loose = makeRepo()
  const commits = git(loose, 'rev-list', 'main').trim().split('\n')
  const files = (sha: string) => git(loose, 'ls-tree', '-r', '--name-only', sha).trim().split('\n')

  it('reads loose objects', async () => {
    expect(git(loose, 'count-objects', '-v')).toMatch(/in-pack: 0/)
    expect(await expectSameAsGit(loose, commits, files)).toBeGreaterThan(100)
  })

  it('reads a pack with OFS_DELTA objects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hindsight-git-ofs-'))
    made.push(dir)
    cpSync(loose, dir, { recursive: true })
    git(dir, 'repack', '-a', '-d', '-f', '-q', '--depth=50', '--window=50')
    git(dir, 'prune-packed')
    expect(git(dir, 'count-objects', '-v')).toMatch(/^count: 0$/m)
    expect(git(dir, 'verify-pack', '-v', ...packIdx(dir))).toMatch(/chain length = [2-9]/)
    expect(await expectSameAsGit(dir, commits, files)).toBeGreaterThan(100)
  })

  it('reads a pack with REF_DELTA objects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hindsight-git-ref-'))
    made.push(dir)
    cpSync(loose, dir, { recursive: true })
    git(dir, '-c', 'repack.useDeltaBaseOffset=false', 'repack', '-a', '-d', '-f', '-q', '--depth=50', '--window=50')
    git(dir, 'prune-packed')
    // A REF_DELTA object's header type is 7: find at least one in the pack.
    expect(await countRefDeltas(dir)).toBeGreaterThan(10)
    expect(await expectSameAsGit(dir, commits, files)).toBeGreaterThan(100)
  })

  it('resolves short hashes and finds files by name', async () => {
    const repo = repoAt(loose)
    expect(await repo.resolve(commits[3].slice(0, 7))).toBe(commits[3])
    const found = await repo.filesNamed(commits[0], 'SpindexerSubsystem.java')
    expect(found).toEqual([{ path: 'src/main/java/frc/robot/subsystems/indexer/SpindexerSubsystem.java', sha: git(loose, 'rev-parse', `${commits[0]}:${found[0].path}`).trim() }])
  })

  it('says why a commit is missing, and that a shallow clone is the reason when it is one', async () => {
    await expect(repoAt(loose).resolve('deadbee')).rejects.toThrow(GitUnreadable)
    const shallow = mkdtempSync(join(tmpdir(), 'hindsight-git-shallow-'))
    made.push(shallow)
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${loose}`, shallow])
    await expect(repoAt(shallow).resolve(commits[5].slice(0, 7))).rejects.toThrow(/shallow clone/)
  })
})

const REAL = process.env.HINDSIGHT_GIT_REPO
describe.skipIf(!REAL)('git reader on a real clone (HINDSIGHT_GIT_REPO)', () => {
  it('reads every Java file at the newest 40 commits of every branch the same as git show', async () => {
    const dir = REAL as string
    const commits = git(dir, 'rev-list', '--all', '--max-count=40').trim().split('\n')
    const java = (sha: string) => git(dir, 'ls-tree', '-r', '--name-only', sha).trim().split('\n').filter((p) => p.endsWith('.java'))
    const checked = await expectSameAsGit(dir, commits, java)
    console.log(`${checked} files at ${commits.length} commits matched git show`)
    expect(checked).toBeGreaterThan(500)
  }, 600_000)

  it('reads the blobs at the end of the longest delta chains the same as git cat-file', async () => {
    const dir = REAL as string
    // verify-pack -v: "<sha> <type> <size> <size-in-pack> <offset> <depth> <base>" for deltified objects.
    const rows = git(dir, 'verify-pack', '-v', ...packIdx(dir)).split('\n').map((l) => l.split(/\s+/)).filter((r) => r[1] === 'blob' && r.length >= 7)
    const deepest = rows.sort((a, b) => Number(b[5]) - Number(a[5])).slice(0, 25)
    expect(Number(deepest[0][5])).toBeGreaterThan(5)
    const repo = repoAt(dir)
    for (const [sha] of deepest) {
      const want = gitBytes(dir, 'cat-file', 'blob', sha)
      expect(Buffer.from((await repo.object(sha)).data).equals(Buffer.from(want)), sha).toBe(true)
    }
  }, 600_000)
})

function packIdx(dir: string): string[] {
  return git(dir, 'rev-parse', '--git-path', 'objects/pack').trim().split('\n').flatMap((p) => {
    const folder = p.startsWith('/') ? p : join(dir, p)
    return execFileSync('ls', [folder], { encoding: 'utf8' }).split('\n').filter((n) => n.endsWith('.idx')).map((n) => join(folder, n))
  })
}

/** How many objects in the repo's packs are stored as REF_DELTA (pack type 7), read from each object's header. */
async function countRefDeltas(dir: string): Promise<number> {
  let n = 0
  for (const idx of packIdx(dir)) {
    const offsets = git(dir, 'verify-pack', '-v', idx).split('\n').map((l) => l.split(/\s+/)).filter((r) => /^[0-9a-f]{40}$/.test(r[0]) && r.length >= 5).map((r) => Number(r[4]))
    const pack = new Uint8Array(execFileSync('cat', [idx.replace(/\.idx$/, '.pack')]))
    for (const at of offsets) if (((pack[at] >> 4) & 7) === 7) n++
  }
  return n
}
