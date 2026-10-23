// Linking the logs an ingest just added, over a fake fetch and a temp library. The org (example-org), repos, commits and
// Codebase text are invented; the test makes no network request.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkAdded } from '../src/hub/ingest-link.ts'
import { ADD_LINK_REQUESTS, linkCode } from '../src/hub/codelink.ts'
import type { IngestReport } from '../src/hub/ingest.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import type { CodeLink, LogRecord } from '../src/hub/types.ts'

const FULL = 'b'.repeat(40)
const COMMITS = ['c000001', 'c000002', 'c000003', 'c000004']

/** example-org holds one repo whose Robot.java records "TestCode" and has the four commits above. */
function fakeGitHub() {
  const calls: string[] = []
  const get = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'x-ratelimit-remaining': '50' } })
    if (url.startsWith('https://raw.githubusercontent.com/')) return new Response('Logger.recordMetadata("Codebase", "TestCode");')
    const path = new URL(url).pathname
    if (path === '/orgs/example-org/repos') return json([{ full_name: 'example-org/robot-9999', default_branch: 'main', pushed_at: '2026-01-01T00:00:00Z' }])
    const commit = /^\/repos\/example-org\/robot-9999\/commits\/(.+)$/.exec(path)
    if (commit) return COMMITS.includes(commit[1]) ? json({ sha: FULL }) : json({ message: 'none' }, 422)
    return json({}, 404)
  }) as typeof fetch
  return { get, calls, api: () => calls.filter((u) => u.startsWith('https://api.github.com/')).length }
}

const record = (n: number, over: Partial<LogRecord> = {}): LogRecord => ({
  type: 'log', sha256: `sha${n}`, kind: 'wpilog', playedAt: n, dateSource: 'robot clock', wall: null, matchWindow: null, event: 'TEST', matchType: null, matchNumber: null, onField: false,
  batteryId: null, roboRio: null, edition: null, robot: { profileId: null, name: 'TestCode', how: 'signals', fit: 0.2 }, build: { sha: COMMITS[n % COMMITS.length], branch: 'main' }, stub: false, hardwareId: null,
  size: 1, path: `logs/x/log${n}.wpilog`, names: [`log${n}.wpilog`], modifiedTime: null, from: 'folder', recordedAt: n, machine: 'm', ...over,
})

const reportOf = (records: LogRecord[]): IngestReport => ({
  added: records.map((r) => ({ name: r.names[0], where: '', path: r.path, size: 1, undated: false, stub: false })),
  already: [], unreadable: [], ignored: 0, bytesAdded: 0, durationMs: 0,
})

let dir: string
let lib: LocalLibrary
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hindsight-ingest-link-')); lib = await LocalLibrary.open(dir, 'machine-a') })
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('linking the logs an ingest added', () => {
  it('links only logs this ingest added that name only their code and have no link yet', async () => {
    const earlierLink: CodeLink = { repo: 'example-org/robot-9999', linkedBy: 'codebase', checkedAt: 1 }
    const fresh = record(1)
    const alreadyLinked = record(2, { code: earlierLink })
    const hasProfile = record(3, { robot: { profileId: 'p', name: 'A robot', how: 'codebase', fit: 1 } })
    const notAdded = record(4)
    for (const r of [fresh, alreadyLinked, hasProfile, notAdded]) await lib.append(r)
    const gh = fakeGitHub()
    const out = await linkAdded(lib, reportOf([fresh, alreadyLinked, hasProfile]), ['example-org'], 'test+linked', { get: gh.get, now: () => 9 })
    expect(out).toEqual({ linked: 1, linkRequests: 2, linkCapped: false }) // 1 listing + 1 commit check
    expect(lib.catalog.bySha('sha1')!.code).toMatchObject({ repo: 'example-org/robot-9999', linkedBy: 'sha', sha: FULL })
    expect(lib.catalog.bySha('sha2')!.code).toEqual(earlierLink)
    expect(lib.catalog.bySha('sha3')!.code).toBeUndefined()
    expect(lib.catalog.bySha('sha4')!.code).toBeUndefined()
  })

  it('asks GitHub nothing when no added log is linkable, or no source is set', async () => {
    const gh = fakeGitHub()
    const withProfile = record(1, { robot: { profileId: 'p', name: 'A robot', how: 'codebase', fit: 1 } })
    await lib.append(withProfile)
    expect(await linkAdded(lib, reportOf([withProfile]), ['example-org'], 'test+linked', { get: gh.get })).toEqual({ linked: 0, linkRequests: 0, linkCapped: false })
    const fresh = record(2)
    await lib.append(fresh)
    expect(await linkAdded(lib, reportOf([fresh]), [], 'test+linked', { get: gh.get })).toEqual({ linked: 0, linkRequests: 0, linkCapped: false })
    expect(gh.calls).toEqual([])
  })

  it('links nothing for a cancelled ingest', async () => {
    const fresh = record(1)
    await lib.append(fresh)
    const gh = fakeGitHub()
    expect(await linkAdded(lib, reportOf([fresh]), ['example-org'], 'test+linked', { get: gh.get, cancelled: () => true })).toBeNull()
    expect(gh.calls).toEqual([])
    expect(lib.catalog.bySha('sha1')!.code).toBeUndefined()
  })

  it('stops at the cap, says capped (not rate limited), and keeps what it linked', async () => {
    const added = [0, 1, 2, 3].map((n) => record(n, { sha256: `s${n}`, path: `logs/x/c${n}.wpilog`, names: [`c${n}.wpilog`] }))
    for (const r of added) await lib.append(r)
    const gh = fakeGitHub()
    // 1 listing + 2 commit checks = 3 API requests; the third check would be the fourth.
    const out = await linkAdded(lib, reportOf(added), ['example-org'], 'test+linked', { get: gh.get, maxRequests: 3 })
    expect(out).toEqual({ linked: 2, linkRequests: 3, linkCapped: true })
    expect(gh.api()).toBe(3)
    expect(added.map((r) => !!lib.catalog.bySha(r.sha256)!.code).filter(Boolean)).toHaveLength(2)
  })

  it('uses a cap of 20 API requests by default', () => {
    expect(ADD_LINK_REQUESTS).toBe(20)
  })
})

describe('linkCode with maxRequests', () => {
  it('reports capped without a rate-limit time, and makes no request past the cap', async () => {
    const gh = fakeGitHub()
    const r = await linkCode(['example-org'], [0, 1, 2, 3].map((n) => record(n)), { get: gh.get, maxRequests: 2 })
    expect(r).toMatchObject({ capped: true, rateLimitedUntil: null, requests: { api: 2 } })
    expect(r.problems).toEqual([])
    expect(r.links.size).toBe(1)
  })

  it('without maxRequests is not capped', async () => {
    const r = await linkCode(['example-org'], [0, 1].map((n) => record(n)), { get: fakeGitHub().get })
    expect(r).toMatchObject({ capped: false, rateLimitedUntil: null })
    expect(r.links.size).toBe(2)
  })
})
