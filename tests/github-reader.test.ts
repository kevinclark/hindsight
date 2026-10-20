// src/code/github.ts with no network: a fake GitHub (tests/helpers/fake-github.ts) serves a small repo built here, and
// scripted answers stand in for the ways GitHub says no. Paths and file contents are invented.
//   HINDSIGHT_LIVE_GITHUB=1 npx vitest run tests/github-reader.test.ts
// also reads the real HighlanderRobotics/2026-Offseason-Robot at cb68b20 (about 2 API calls of the 60 an hour).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CommitMissing, GitRepo, GitUnreadable } from '../src/code/git.ts'
import { GitHubRepo, parseGitHub } from '../src/code/github.ts'
import { hintsAt } from '../src/builder/code-hints.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { fakeGitHub, json, memoryKept } from './helpers/fake-github.ts'

const REPO = 'example-team/robot'
const dir = mkdtempSync(join(tmpdir(), 'hindsight-github-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
git('init', '-q', '-b', 'event')
mkdirSync(join(dir, 'src/main/java/frc/robot'), { recursive: true })
writeFileSync(join(dir, 'src/main/java/frc/robot/Shooter.java'), 'class Shooter {\n  TalonFX a = new TalonFX(10);\n}\n')
writeFileSync(join(dir, 'README.md'), 'robot\n')
git('add', '-A')
git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c')
const head = git('rev-parse', 'HEAD')
const SHOOTER = 'src/main/java/frc/robot/Shooter.java'

const github = (fake = fakeGitHub(dir, REPO), kept = memoryKept()) => ({ fake, kept, repo: new GitHubRepo(REPO, kept, fake.fetch) })
/** A fetch that answers every request the same way. */
const always = (answer: () => Response | Promise<Response>) => (async () => answer()) as typeof fetch

describe('reading a public repo', () => {
  it('branch → full hash → file list → file text, as a code folder reads them', async () => {
    const { repo, fake } = github()
    const sha = await repo.resolve('event')
    expect(sha).toBe(head)
    const local = new GitRepo(nodeGitDir(dir)!)
    expect(await repo.files(sha)).toEqual(await local.files(sha))
    expect(await repo.textAt(sha, SHOOTER)).toBe(await local.textAt(sha, SHOOTER))
    expect(fake.asked).toEqual([
      `https://api.github.com/repos/${REPO}/commits/event`,
      `https://api.github.com/repos/${REPO}/git/trees/${head}?recursive=1`,
      `https://raw.githubusercontent.com/${REPO}/${head}/${SHOOTER}`,
    ])
    expect(repo.calls).toEqual({ api: 2, raw: 1 })
  })
  it('sends nothing credential-shaped: no cookies, no headers', async () => {
    const { repo, fake } = github()
    await repo.textAt(head, SHOOTER)
    expect(fake.inits).toEqual([{ credentials: 'omit' }])
  })
  it('a full hash needs no call; a short one needs one, kept for next time; a branch is asked again', async () => {
    const { repo, fake, kept } = github()
    expect(await repo.resolve(head.toUpperCase())).toBe(head)
    expect(fake.asked).toEqual([])
    expect(await repo.resolve(head.slice(0, 7))).toBe(head)
    expect(await repo.resolve('event')).toBe(head)
    expect(fake.asked).toHaveLength(2)
    const next = github(undefined, kept)
    expect(await next.repo.resolve(head.slice(0, 7))).toBe(head)
    expect(await next.repo.resolve('event')).toBe(head)
    expect(next.fake.asked).toEqual([`https://api.github.com/repos/${REPO}/commits/event`])
  })
  it('a commit\'s file list is kept: the next visit makes no call', async () => {
    const { repo, kept } = github()
    const files = await repo.files(head)
    const next = github(undefined, kept)
    expect(await next.repo.files(head)).toEqual(files)
    expect(next.fake.asked).toEqual([])
    expect([...kept.kept.keys()]).toEqual([`tree:${REPO}@${head}`])
  })
  it('thirteen motor groups asking at once cost one call', async () => {
    const { repo, fake } = github()
    await Promise.all(Array.from({ length: 13 }, () => repo.files(head)))
    await Promise.all(Array.from({ length: 13 }, () => repo.resolve('event')))
    expect(fake.asked).toHaveLength(2)
  })
  it('leaves out folders and submodules, as a code folder does', async () => {
    const tree = [{ path: 'src', type: 'tree', sha: 'a'.repeat(40) }, { path: 'src/A.java', type: 'blob', sha: 'b'.repeat(40) }, { path: 'lib', type: 'commit', sha: 'c'.repeat(40) }]
    const repo = new GitHubRepo(REPO, memoryKept(), always(() => json(200, { truncated: false, tree })))
    expect(await repo.files(head)).toEqual([{ path: 'src/A.java', sha: 'b'.repeat(40) }])
  })
})

describe('when GitHub says no', () => {
  const reason = async (work: Promise<unknown>) => work.then(() => 'answered', (e) => (e instanceof GitUnreadable ? e.message : `threw ${e}`))
  it('a private, misspelled or missing repo: says so and points at the code folder', async () => {
    const repo = new GitHubRepo('example-team/secret', memoryKept(), fakeGitHub(dir, REPO).fetch)
    expect(await reason(repo.resolve('event'))).toBe('GitHub has no public repo example-team/secret (private, misspelled or gone): choose the code folder instead')
  })
  it('a commit or branch it doesn\'t have (422): CommitMissing, not pushed or rebased away', async () => {
    const { repo } = github()
    const missing = await repo.resolve('abcdef1').catch((e) => e)
    expect(missing).toBeInstanceOf(CommitMissing)
    expect(missing.message).toBe(`commit abcdef1 isn't on GitHub in ${REPO} (not pushed, rebased away or misspelled): choose the code folder instead`)
    expect(await repo.files('f'.repeat(40)).catch((e) => e)).toBeInstanceOf(CommitMissing)
  })
  it('a lasting no is asked once: thirteen groups whose commit GitHub lacks cost one call', async () => {
    const { repo, fake } = github()
    for (let group = 0; group < 13; group++) await repo.resolve('abcdef1').catch(() => {})
    expect(fake.asked).toHaveLength(1)
  })
  it('the 60-an-hour limit used up: says when it resets, and nothing is kept', async () => {
    const reset = Date.UTC(2026, 9, 20, 22, 7) / 1000
    const at = new Date(reset * 1000).toTimeString().slice(0, 5)
    const kept = memoryKept()
    const limited = always(() => json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }))
    const repo = new GitHubRepo(REPO, kept, limited)
    expect(await reason(repo.files(head))).toBe(`GitHub's limit for this network (60 an hour without signing in) is used up; it resets at ${at}. Choose the code folder instead.`)
    expect(kept.kept.size).toBe(0)
  })
  it('a file list cut short (truncated): says so, no walking folder by folder', async () => {
    const repo = new GitHubRepo(REPO, memoryKept(), always(() => json(200, { truncated: true, tree: [] })))
    expect(await reason(repo.files(head))).toMatch(/GitHub sent only part of .*'s file list at [0-9a-f]{7} \(too many files\): choose the code folder/)
  })
  it('offline: "couldn\'t reach GitHub", and the next look tries again', async () => {
    let online = false
    const fake = fakeGitHub(dir, REPO)
    const repo = new GitHubRepo(REPO, memoryKept(), (async (url: string, init?: RequestInit) => {
      if (!online) throw new TypeError('Failed to fetch')
      return fake.fetch(url, init)
    }) as typeof fetch)
    expect(await reason(repo.resolve('event'))).toBe('couldn\'t reach GitHub (offline?): choose the code folder instead')
    online = true
    expect(await repo.resolve('event')).toBe(head)
  })
  it('a file missing at the commit', async () => {
    const { repo } = github()
    expect(await reason(repo.textAt(head, 'src/Nowhere.java'))).toBe(`src/Nowhere.java isn't in commit ${head.slice(0, 7)}`)
  })
})

describe('naming a repo', () => {
  it('reads owner/name@branch, a hash, or a pasted link', () => {
    expect(parseGitHub('HighlanderRobotics/Rebuilt@event-calgames')).toEqual({ repo: 'HighlanderRobotics/Rebuilt', ref: 'event-calgames' })
    expect(parseGitHub(' example-team/robot.code@cb68b20 ')).toEqual({ repo: 'example-team/robot.code', ref: 'cb68b20' })
    expect(parseGitHub('https://github.com/example-team/robot/tree/feature/auto')).toEqual({ repo: 'example-team/robot', ref: 'feature/auto' })
    expect(parseGitHub('example-team/robot')).toBeNull()
  })
})

// Opt-in: the real repo a built-in profile names, at the commit the 2026 offseason profile pins. HINDSIGHT_LIVE_CLONE
// (a clone of it) also checks the hints against the same commit read from the clone's .git.
describe.skipIf(!process.env.HINDSIGHT_LIVE_GITHUB)('live: HighlanderRobotics/2026-Offseason-Robot at cb68b20', () => {
  it('reads 49 Java/Kotlin files, and the profile builder\'s hints equal a local clone\'s', async () => {
    const live = new GitHubRepo('HighlanderRobotics/2026-Offseason-Robot', memoryKept())
    const hints = await hintsAt(live, 'cb68b20')
    const sources = (await live.files(hints.sha!)).filter((f) => /\.(java|kt)$/.test(f.path))
    console.log(`live GitHub: ${sources.length} Java/Kotlin files, ${hints.sites.length} Talon FX sites, ${live.calls.api} API calls, ${live.calls.raw} raw reads`)
    expect(sources).toHaveLength(49)
    expect(live.calls.api).toBe(2)
    const clone = process.env.HINDSIGHT_LIVE_CLONE
    if (clone) expect(hints).toEqual(await hintsAt(new GitRepo(nodeGitDir(clone)!), 'cb68b20'))
  }, 60_000)
})
