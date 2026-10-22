// Robot identity, re-reading through the manifest, event names from the FMS table, and the job runner. Invented data (event TEST).
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeLog, robotIdentity } from '../src/hub/describe.ts'
import { describeFile, type Described } from '../src/hub/describe-file.ts'
import { Catalog } from '../src/hub/catalog.ts'
import { fmsPlace, facetValues, robotIsGuess } from '../src/hub/facets.ts'
import { resolveEvent, eventTableYears } from '../src/hub/events.ts'
import { ingest, localFolderFiles } from '../src/hub/ingest.ts'
import { JobRunner } from '../src/hub/jobs.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { redescribe } from '../src/hub/redescribe.ts'
import { parseManifest, serializeRecord, type LogRecord, type MetaRecord } from '../src/hub/types.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { robotLog } from './helpers/hub-logs.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0)
const ENABLED: [number, number] = [20, 55]
const profile = PROFILES.find((p) => p.codebase === '2026 Offseason' && p.code.branch === 'main')!

describe('the robot a log is from', () => {
  it('names the profile when the log\'s Codebase and branch match one', () => {
    const m = describeLog('x.wpilog', robotLog({ clockMs: CLOCK, codebase: profile.codebase, branch: profile.code.branch }))
    expect(m.robot).toMatchObject({ profileId: expect.any(String), name: profile.name, how: 'codebase and branch' })
  })
  it('names the profile when only the Codebase matches', () => {
    const m = describeLog('x.wpilog', robotLog({ clockMs: CLOCK, codebase: profile.codebase, branch: 'some-other-branch' }))
    expect(m.robot).toMatchObject({ profileId: expect.any(String), name: profile.name, how: 'codebase' })
  })
  it('records the log\'s own Codebase text, no profile, when the best fit is a misfit', () => {
    const m = describeLog('x.wpilog', robotLog({ clockMs: CLOCK, codebase: 'TestCode2020' }))
    expect(m.robot).toMatchObject({ profileId: null, name: 'TestCode2020', how: 'signals' })
    expect(m.robot!.fit).toBeGreaterThanOrEqual(0)
    expect(m.robot!.fit).toBeLessThan(0.6)
  })
  it('records no robot when the log names none and nothing fits', () => {
    expect(describeLog('x.wpilog', robotLog({ clockMs: CLOCK })).robot).toBeNull()
  })
  it('names the profile for a signals match that is not a misfit', () => {
    const fit = { present: 9, total: 10 }
    expect(robotIdentity(profile, { how: 'signals', note: null, fit, misfit: false }, 'TestCode')).toMatchObject({ profileId: expect.any(String), name: profile.name, how: 'signals', fit: 0.9 })
    expect(robotIdentity(profile, { how: 'signals', note: null, fit: { present: 3, total: 10 }, misfit: true }, 'TestCode')).toEqual({ profileId: null, name: 'TestCode', how: 'signals', fit: 0.3 })
    expect(robotIdentity(profile, { how: 'signals', note: null, fit: { present: 0, total: 0 }, misfit: true }, '')).toBeNull()
  })
  it('marks a code name or a signals guess, not a codebase match', () => {
    const named = describeLog('x.wpilog', robotLog({ clockMs: CLOCK, codebase: profile.codebase }))
    const code = describeLog('x.wpilog', robotLog({ clockMs: CLOCK, codebase: 'TestCode2020' }))
    expect(robotIsGuess(named)).toBe(false)
    expect(robotIsGuess(code)).toBe(true)
  })
})

const base = (over: Partial<LogRecord> = {}): LogRecord => ({
  type: 'log', kind: 'wpilog', playedAt: Date.UTC(2026, 9, 17, 19), dateSource: 'robot clock', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null,
  onField: false, batteryId: null, robot: { profileId: 'p', name: 'Robot A', how: 'signals', fit: 0.2 }, build: null, stub: false, hardwareId: null,
  sha256: 'a1', size: 1, path: 'logs/2026-2027/2026-10-17/a.wpilog', names: ['a.wpilog'], modifiedTime: null, from: 'folder', recordedAt: 10, machine: 'm1', ...over,
})
const meta = (m: Partial<LogRecord>, recordedAt: number, sha256 = 'a1'): MetaRecord => ({ type: 'meta', sha256, meta: m, recordedAt, machine: 'm2' })

describe('a later reading laid over a log record', () => {
  it('parses a meta record and skips a malformed one', () => {
    const text = serializeRecord(meta({ event: 'TEST' }, 20)) + '{"type":"meta","sha256":"a1"}\n{"type":"future","sha256":"a1"}\n'
    const { records, skipped } = parseManifest(text)
    expect(records.map((r) => r.type)).toEqual(['meta'])
    expect(skipped).toBe(2)
  })
  it('shows the latest meta, whichever order the records arrive in', () => {
    const c = new Catalog()
    c.add(meta({ event: 'newest' }, 40)); c.add(base()); c.add(meta({ event: 'older' }, 20))
    expect(c.bySha('a1')!.event).toBe('newest')
    expect(c.entries()[0].record.event).toBe('newest')
    expect(c.all()).toHaveLength(1)
  })
  it('never lets a meta change the path, kind, date or its source', () => {
    const c = new Catalog()
    c.add(base())
    c.add(meta({ kind: 'dslog', playedAt: 5, dateSource: 'file name', robot: null, onField: true, event: 'TEST' }, 20))
    const r = c.bySha('a1')!
    expect(r).toMatchObject({ kind: 'wpilog', playedAt: Date.UTC(2026, 9, 17, 19), dateSource: 'robot clock', path: 'logs/2026-2027/2026-10-17/a.wpilog', robot: null, onField: true, event: 'TEST' })
  })
  it('leaves a log with no meta, and a meta for a log nobody holds, alone', () => {
    const c = new Catalog()
    c.add(base()); c.add(base({ sha256: 'b2', path: 'logs/x/b.wpilog' })); c.add(meta({ event: 'TEST' }, 20, 'zz'))
    expect(c.bySha('a1')!.event).toBe('')
    expect(c.bySha('zz')).toBeUndefined()
    expect(c.size).toBe(2)
  })
  it('keeps names from a second machine\'s record of the same bytes', () => {
    const c = new Catalog()
    c.add(base()); c.add(meta({ event: 'TEST' }, 20)); c.add(base({ recordedAt: 30, names: ['copy.wpilog'] }))
    expect(c.bySha('a1')!.names.sort()).toEqual(['a.wpilog', 'copy.wpilog'])
    expect(c.bySha('a1')!.event).toBe('TEST')
  })
})

describe('event names from the FMS table', () => {
  const y = (year: number) => Date.UTC(year, 5, 1)
  it('resolves a code in any case for the log\'s year', () => {
    expect(resolveEvent('cacg', y(2026))).toBe('CalGames 2026')
    expect(resolveEvent('CACG', y(2026))).toBe('CalGames 2026')
    expect(resolveEvent('CASNF', y(2026))).toBe('CA District San Francisco Event')
  })
  it('resolves a division word to the division\'s entry', () => {
    expect(resolveEvent('MILSTEIN', y(2024))).toBe('Milstein Division')
    expect(resolveEvent('mil', y(2024))).toBe('Milstein Division')
  })
  it('resolves nothing for an empty string, an unknown code, another year, or no date', () => {
    expect(resolveEvent('', y(2026))).toBeNull()
    expect(resolveEvent('  ', y(2026))).toBeNull()
    expect(resolveEvent('TEST', y(2026))).toBeNull()
    expect(resolveEvent('cacg', y(2025))).toBeNull()
    expect(resolveEvent('cacg', null)).toBeNull()
    expect(resolveEvent('_source', y(2026))).toBeNull()
  })
  it('has the seed years', () => { expect(eventTableYears()).toEqual([2023, 2024, 2025, 2026]) })
  it('names the place of an on-field log, falling back to the FMS text, and a typed place never overrides it', () => {
    expect(fmsPlace({ onField: true, event: 'cacg', playedAt: y(2026) })).toEqual({ name: 'CalGames 2026', resolved: true })
    expect(fmsPlace({ onField: true, event: 'TEST', playedAt: y(2026) })).toEqual({ name: 'TEST', resolved: false })
    expect(fmsPlace({ onField: false, event: 'cacg', playedAt: y(2026) })).toBeNull()
    const c = new Catalog()
    c.add(base({ onField: true, event: 'cacg' }))
    c.add({ type: 'tag', target: { log: 'a1' }, field: 'place', value: 'Shop', recordedAt: 50, machine: 'm1' })
    expect(facetValues(c.entries()[0]).place).toBe('CalGames 2026')
  })
})

describe('the job runner', () => {
  it('runs one job at a time, remembers its progress, and says when it ends', async () => {
    const runner = new JobRunner()
    const events: unknown[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const first = runner.run('First', async (_j, progress) => { progress(1, 4, 'a.wpilog'); await gate; return 'ok' }, (p) => events.push(p))
    expect(runner.current()).toEqual({ job: 'First', done: 1, total: 4, current: 'a.wpilog' })
    await expect(runner.run('Second', async () => 'no')).rejects.toThrow('Another job is running')
    runner.cancel()
    release()
    expect(await first).toBe('ok')
    expect(runner.current()).toBeNull()
    expect(events).toEqual([{ job: 'First', done: 1, total: 4, current: 'a.wpilog' }, null])
    expect(await runner.run('Third', async () => 3)).toBe(3)
  })
  it('reports a job that has not sent progress yet by its name', async () => {
    const runner = new JobRunner()
    let seen: unknown
    await runner.run('Quiet', async () => { seen = runner.current() })
    expect(seen).toEqual({ job: 'Quiet', done: 0, total: 0, current: '' })
  })
})

describe('reading a library\'s logs again', () => {
  let work: string
  let libRoot: string
  let lib: LocalLibrary
  const names = ['a', 'b', 'c', 'd', 'e']
  const pathOf = (n: string) => lib.catalog.all().find((r) => r.names[0] === `${n}.wpilog`)!.path

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'hindsight-reread-'))
    const source = join(work, 'source')
    libRoot = join(work, 'library')
    await mkdir(source)
    for (const n of names) await writeFile(join(source, `${n}.wpilog`), robotLog({ clockMs: CLOCK, enabled: ENABLED, event: 'TEST', fms: true, seed: n }))
    lib = await LocalLibrary.open(libRoot, 'm1')
    await ingest(lib, await localFolderFiles(source), { describe: describeFile })
    await unlink(lib.store.at(pathOf('c'))) // in the manifest, not on this computer
  })
  afterAll(async () => { await rm(work, { recursive: true, force: true }) })

  const manifestLines = async () => (await readFile(join(libRoot, lib.ownManifestPath), 'utf8')).split('\n').filter(Boolean)

  it('appends a meta record only for logs that read differently, and counts every outcome', async () => {
    const before = await manifestLines()
    const record = (n: string) => lib.catalog.all().find((r) => r.names[0] === `${n}.wpilog`)!
    const fake = async (path: string, name: string): Promise<Described> => {
      if (name === 'd.wpilog') throw new Error('unreadable test log')
      const real = await describeFile(path, name)
      if (name === 'a.wpilog') return { ...real, meta: { ...real.meta, event: 'cacg', robot: { profileId: null, name: 'TestCode', how: 'signals', fit: 0.1 }, playedAt: 1, kind: 'dslog' } }
      if (name === 'e.wpilog') return { ...real, sha256: 'f'.repeat(64) }
      return real
    }
    const seen: string[] = []
    const report = await redescribe(lib, { describe: fake, onProgress: (_d, _t, current) => seen.push(current) })
    expect(report).toEqual({
      wpilogs: 5, changed: 1, unchanged: 1, missing: 1,
      failed: [{ path: pathOf('d'), reason: 'unreadable test log' }, { path: pathOf('e'), reason: expect.stringContaining('sha-256') }],
    })
    expect(seen.at(-1)).toBe('')
    const after = await manifestLines()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 1)
    const written = JSON.parse(after.at(-1)!) as MetaRecord
    expect(written).toMatchObject({ type: 'meta', sha256: record('a').sha256, machine: 'm1' })
    // The fields that decide where the file lives are not in what was written, and the catalog keeps them.
    expect(Object.keys(written.meta)).not.toContain('playedAt')
    expect(Object.keys(written.meta)).not.toContain('kind')
    const a = lib.catalog.bySha(record('a').sha256)!
    expect(a).toMatchObject({ event: 'cacg', kind: 'wpilog', dateSource: 'robot clock' })
    expect(a.robot).toEqual({ profileId: null, name: 'TestCode', how: 'signals', fit: 0.1 })
    expect(a.playedAt).not.toBe(1)
    // A fresh open of the library reads the same.
    const reopened = await LocalLibrary.open(libRoot, 'm1')
    expect(reopened.catalog.bySha(a.sha256)).toEqual(a)
  })

  it('finds nothing to change the second time', async () => {
    const before = await manifestLines()
    const same = await redescribe(lib, { describe: async (path, name) => {
      const real = await describeFile(path, name)
      return name === 'a.wpilog' ? { ...real, meta: { ...real.meta, event: 'cacg', robot: { profileId: null, name: 'TestCode', how: 'signals', fit: 0.1 } } } : real
    } })
    expect(same).toMatchObject({ wpilogs: 5, changed: 0, unchanged: 4, missing: 1, failed: [] })
    expect(await manifestLines()).toEqual(before)
  })

  it('stops when cancelled', async () => {
    let calls = 0
    const report = await redescribe(lib, { describe: describeFile, cancelled: () => calls++ >= 1 })
    expect(report.changed + report.unchanged + report.missing + report.failed.length).toBeLessThan(5)
  })
})
