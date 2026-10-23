// Linking a log to its code from GitHub, over a fake fetch. The org, repos, commits and Codebase texts are invented.
import { describe, expect, it } from 'vitest'
import { describeCodeLink, estimateRequests, linkCode, linkable, preferred, validSource } from '../src/hub/codelink.ts'
import type { LogRecord } from '../src/hub/types.ts'

const FULL = 'a'.repeat(40)
const robotJava = (codebase: string) => `public void robotInit() {\n  Logger.recordMetadata("Codebase", "${codebase}");\n}\n`

interface Repo { name: string; branch?: string; pushed: string; codebase?: string; commits?: string[] }
const REPOS: Repo[] = [
  { name: 'robot-main', pushed: '2026-03-01T00:00:00Z', codebase: 'TestCode', commits: ['abc1234'] },
  { name: 'robot-template', pushed: '2026-06-01T00:00:00Z', codebase: 'TestCode' },
  { name: 'robot-training', pushed: '2026-07-01T00:00:00Z', codebase: 'TestCode' },
  { name: 'robot-older', pushed: '2025-01-01T00:00:00Z', codebase: 'TestCode' },
  { name: 'solo', branch: 'trunk', pushed: '2026-01-01T00:00:00Z', codebase: 'SoloCode' },
  { name: 'no-code', pushed: '2026-01-01T00:00:00Z' },
]

function fakeGitHub(opts: { repos?: Repo[]; limitAfter?: number; remaining?: number; failCommits?: number; asUser?: boolean } = {}) {
  const repos = opts.repos ?? REPOS
  const calls: string[] = []
  let api = 0
  let commitCalls = 0
  const get = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      const [, owner, name, branch, ...path] = new URL(url).pathname.split('/')
      const repo = repos.find((r) => `${owner}/${r.name}` === `testorg/${name}` && (r.branch ?? 'main') === branch)
      if (!repo || path.join('/') !== 'src/main/java/frc/robot/Robot.java' || !repo.codebase) return new Response('not found', { status: 404 })
      return new Response(robotJava(repo.codebase))
    }
    api++
    const left = opts.limitAfter !== undefined && api > opts.limitAfter ? '0' : String(opts.remaining ?? 50 - api)
    const headers = { 'x-ratelimit-remaining': left, 'x-ratelimit-reset': '1800000000' }
    if (opts.limitAfter !== undefined && api > opts.limitAfter) return json({ message: 'rate limit' }, 403, headers)
    const u = new URL(url)
    if (u.pathname === '/orgs/testorg/repos' && opts.asUser) return json({ message: 'Not Found' }, 404, headers)
    const single = /^\/repos\/testorg\/([^/]+)$/.exec(u.pathname)
    if (single) {
      const r = repos.find((x) => x.name === single[1])
      return r ? json({ full_name: `testorg/${r.name}`, default_branch: r.branch ?? 'main', pushed_at: r.pushed }, 200, headers) : json({}, 404, headers)
    }
    if (u.pathname === (opts.asUser ? '/users/testorg/repos' : '/orgs/testorg/repos')) {
      const page = Number(u.searchParams.get('page') ?? 1)
      return json(repos.slice((page - 1) * 100, page * 100).map((r) => ({ full_name: `testorg/${r.name}`, default_branch: r.branch ?? 'main', pushed_at: r.pushed })), 200, headers)
    }
    const commit = /^\/repos\/testorg\/([^/]+)\/commits\/(.+)$/.exec(u.pathname)
    if (commit && ++commitCalls <= (opts.failCommits ?? 0)) return json({ message: 'bad gateway' }, 502, headers)
    if (commit) {
      const repo = repos.find((r) => r.name === commit[1])
      return repo?.commits?.includes(commit[2]) ? json({ sha: FULL, commit: { author: { name: 'someone', email: 'x@example.com' } } }, 200, headers) : json({ message: 'No commit found' }, 422, headers)
    }
    return json({}, 404, headers)
  }) as typeof fetch
  return { get, calls, api: () => api }
}

const log = (sha256: string, over: Partial<LogRecord> = {}): LogRecord => ({
  type: 'log', sha256, kind: 'wpilog', playedAt: 1, dateSource: 'robot clock', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null, onField: false,
  batteryId: null, roboRio: null, edition: null, robot: { profileId: null, name: 'TestCode', how: 'signals', fit: 0.2 }, build: null, stub: false, hardwareId: null,
  size: 1, path: `logs/x/${sha256}.wpilog`, names: [`${sha256}.wpilog`], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'm', ...over,
})

describe('linking a log to its code', () => {
  it('prefers the repo that holds the log\'s commit, records the full commit and the losing candidates', async () => {
    const gh = fakeGitHub()
    const r = await linkCode(['testorg'], [log('l1', { build: { sha: 'abc1234', branch: 'main' } })], { get: gh.get, now: () => 7 })
    expect(r.links.get('l1')).toEqual({ repo: 'testorg/robot-main', linkedBy: 'sha', sha: FULL, candidates: ['testorg/robot-template', 'testorg/robot-training', 'testorg/robot-older'], checkedAt: 7 })
    // 1 listing + one commit check for each of the 4 repos that record the text; every Robot.java read is a raw read.
    expect(r.requests).toEqual({ api: 5, raw: 6 })
    expect(gh.calls.filter((u) => u.includes('api.github.com') && u.includes('/commits/'))).toHaveLength(4)
    expect(r.rateLimitedUntil).toBeNull()
  })

  it('falls back to the Codebase text when no candidate has the commit (422), choosing a plain name, then the latest push', async () => {
    const r = await linkCode(['testorg'], [log('l1', { build: { sha: 'dead999', branch: 'x' } })], { get: fakeGitHub().get, now: () => 7 })
    expect(r.links.get('l1')).toMatchObject({ repo: 'testorg/robot-main', linkedBy: 'codebase', candidates: ['testorg/robot-template', 'testorg/robot-training', 'testorg/robot-older'] })
    expect(r.links.get('l1')!.sha).toBeUndefined()
  })

  it('makes no commit request for a log with no build, and ignores logs a profile names or another link settled', async () => {
    const gh = fakeGitHub()
    const records = [log('l1'), log('l2', { robot: { profileId: 'p', name: 'Named', how: 'codebase', fit: 1 } }), log('l3', { code: { repo: 'testorg/robot-main', linkedBy: 'sha', sha: FULL, checkedAt: 1 }, build: { sha: 'abc1234', branch: 'm' } }), log('l4', { kind: 'dslog' })]
    const r = await linkCode(['testorg'], records, { get: gh.get })
    expect([...r.links.keys()]).toEqual(['l1'])
    expect(r.requests.api).toBe(1)
    expect(linkable(records[1])).toBe(false)
  })

  it('counts a Codebase text no listed repo records, and reads each repo\'s default branch', async () => {
    const gh = fakeGitHub()
    const r = await linkCode(['testorg'], [log('l1', { robot: { profileId: null, name: 'Nobody', how: 'signals', fit: 0 } }), log('l2', { robot: { profileId: null, name: 'SoloCode', how: 'signals', fit: 0 } })], { get: gh.get })
    expect(r.unmatched).toBe(1)
    expect(r.links.get('l2')).toMatchObject({ repo: 'testorg/solo', linkedBy: 'codebase' })
    expect(r.links.get('l2')!.candidates).toBeUndefined()
    expect(gh.calls).toContain('https://raw.githubusercontent.com/testorg/solo/trunk/src/main/java/frc/robot/Robot.java')
  })

  it('stops when GitHub says no requests remain, reports the reset time and keeps the links made before', async () => {
    const gh = fakeGitHub({ limitAfter: 3 }) // the listing and two commit checks are answered; the third is refused
    const records = [log('l1', { build: { sha: 'abc1234', branch: 'm' } }), log('l2', { robot: { profileId: null, name: 'SoloCode', how: 'signals', fit: 0 } }), log('l3', { build: { sha: 'abc1234', branch: 'm' } })]
    const r = await linkCode(['testorg'], records, { get: gh.get })
    expect(r.rateLimitedUntil).toBe(1800000000 * 1000)
    expect(r.links.has('l1')).toBe(false) // its commit checks were cut off, so it is left for next time
    expect(gh.api()).toBe(4) // nothing is asked after the refusal
  })

  it('keeps links made before a limit that arrives with an answer (remaining 0 on a 200)', async () => {
    const gh = fakeGitHub({ remaining: 0 })
    const r = await linkCode(['testorg'], [log('l1')], { get: gh.get })
    expect(r.links.size).toBe(1) // the listing succeeded with its last request; no commit checks were needed
    expect(r.rateLimitedUntil).toBe(1800000000 * 1000)
  })

  it('pages an org of more than 100 repos', async () => {
    const many: Repo[] = Array.from({ length: 101 }, (_, i) => ({ name: `r${i}`, pushed: '2026-01-01T00:00:00Z' }))
    const gh = fakeGitHub({ repos: many })
    const r = await linkCode(['testorg'], [log('l1')], { get: gh.get })
    expect(r.repos).toBe(101)
    expect(gh.api()).toBe(2)
  })

  it('treats a failed commit check as unknown, says so once, carries on, and asks again rather than remembering the failure', async () => {
    const gh = fakeGitHub({ failCommits: 1 }) // the first commit check gets a 502, every later one is answered
    const b = { sha: 'abc1234', branch: 'm' }
    const r = await linkCode(['testorg'], [log('l1', { build: b }), log('l2', { build: b })], { get: gh.get })
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toContain('502')
    expect(r.links.get('l1')).toMatchObject({ repo: 'testorg/robot-main', linkedBy: 'codebase' }) // robot-main's check failed for l1
    expect(r.links.get('l2')).toMatchObject({ repo: 'testorg/robot-main', linkedBy: 'sha', sha: FULL }) // the same check, asked again, succeeded
    expect(r.rateLimitedUntil).toBeNull()
  })

  it('tries a bare name as a user when no organization has it (one more request), and reads owner/repo from the repo itself', async () => {
    const user = fakeGitHub({ asUser: true })
    const r = await linkCode(['testorg'], [log('l1')], { get: user.get })
    expect(r.repos).toBe(6)
    expect(r.links.get('l1')).toMatchObject({ repo: 'testorg/robot-main' })
    expect(user.calls.filter((u) => u.includes('api.github.com')).map((u) => new URL(u).pathname)).toEqual(['/orgs/testorg/repos', '/users/testorg/repos'])
    const one = fakeGitHub()
    const r2 = await linkCode(['testorg/solo'], [log('l1', { robot: { profileId: null, name: 'SoloCode', how: 'signals', fit: 0 } })], { get: one.get })
    expect(r2.links.get('l1')).toMatchObject({ repo: 'testorg/solo', linkedBy: 'codebase' })
    expect(r2.requests).toEqual({ api: 1, raw: 1 })
  })

  it('shows only a well-formed link', () => {
    const bad = (code: unknown) => describeCodeLink(log('l1', { code: code as never }))
    expect(bad({ repo: 'noslash', linkedBy: 'sha', checkedAt: 1 })).toBeNull()
    expect(bad({ repo: '../x/y', linkedBy: 'codebase', checkedAt: 1 })).toBeNull()
    expect(bad({ repo: 'o/r', linkedBy: 'guess', checkedAt: 1 })).toBeNull()
    expect(bad({ repo: 'o/r', linkedBy: 'sha', sha: 'not-hex', checkedAt: 1 })).toBeNull()
    expect(bad({ repo: 'o/r', linkedBy: 'sha', sha: 'a'.repeat(39), checkedAt: 1 })).toBeNull()
    expect(bad('o/r')).toBeNull()
    expect(bad({ repo: 'o/r', linkedBy: 'codebase', checkedAt: 1 })).not.toBeNull()
  })

  it('tie-break: plain names first, then the latest push', () => {
    const repo = (full: string, pushedAt: string) => ({ full, defaultBranch: 'main', pushedAt })
    expect(preferred([repo('o/x-Template', '2026-09'), repo('o/x', '2026-01')]).full).toBe('o/x')
    expect(preferred([repo('o/a', '2026-01'), repo('o/b', '2026-02')]).full).toBe('o/b')
    expect(preferred([repo('o/Training-a', '2026-05'), repo('o/Template-b', '2026-06')]).full).toBe('o/Template-b')
  })

  it('estimates the most API requests: one listing per source and one check per distinct (Codebase, build)', () => {
    const b = { sha: 'abc1234', branch: 'm' }
    expect(estimateRequests([], [log('l1', { build: b })])).toBe(0)
    expect(estimateRequests(['testorg'], [log('l1', { build: b }), log('l2', { build: b }), log('l3', { build: { sha: 'ffff000', branch: 'm' } }), log('l4')])).toBe(3)
  })

  it('words a link, and builds its URL from the repo and commit', () => {
    expect(describeCodeLink(log('l1', { code: { repo: 'testorg/robot-main', linkedBy: 'sha', sha: FULL, checkedAt: 1 } }))).toEqual({ text: 'testorg/robot-main @ aaaaaaa', url: `https://github.com/testorg/robot-main/commit/${FULL}` })
    expect(describeCodeLink(log('l1', { code: { repo: 'testorg/robot-main', linkedBy: 'codebase', checkedAt: 1 }, build: { sha: 'dead999', branch: 'm' } }))).toEqual({ text: 'testorg/robot-main (named by the log; commit dead999 not on GitHub)', url: 'https://github.com/testorg/robot-main' })
    expect(describeCodeLink(log('l1', { code: { repo: 'testorg/robot-main', linkedBy: 'codebase', checkedAt: 1 } }))?.text).toBe('testorg/robot-main (named by the log)')
    expect(describeCodeLink(log('l1'))).toBeNull()
  })

  it('accepts an org name or owner/repo and nothing else', () => {
    expect(['testorg', 'test-org/repo.name', 'a_b/c'].every(validSource)).toBe(true)
    expect(['', 'a/b/c', '../x', 'a b', 'https://github.com/x'].some(validSource)).toBe(false)
  })
})
