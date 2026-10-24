// Robot identity, re-reading through the manifest, event names from the FMS table, and the job runner. Invented data (event TEST).
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeLog, robotIdentity } from '../src/hub/describe.ts'
import { describeFile, type Described } from '../src/hub/describe-file.ts'
import { Catalog, newerReading } from '../src/hub/catalog.ts'
import { fmsPlace, facetValues, robotIsGuess, robotLabels } from '../src/hub/facets.ts'
import table2026 from '../src/hub/events/2026.json' with { type: 'json' }
import { resolveEvent, resolveIn, eventTableYears, withYear } from '../src/hub/events.ts'
import { ingest, localFolderFiles } from '../src/hub/ingest.ts'
import { JobRunner } from '../src/hub/jobs.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { readingOf, redescribe } from '../src/hub/redescribe.ts'
import { applyLinks } from '../src/hub/links.ts'
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
  onField: false, batteryId: null, roboRio: null, edition: null, robot: { profileId: 'p', name: 'Robot A', how: 'signals', fit: 0.2 }, build: null, stub: false, hardwareId: null,
  sha256: 'a1', size: 1, path: 'logs/2026-2027/2026-10-17/a.wpilog', names: ['a.wpilog'], modifiedTime: null, from: 'folder', recordedAt: 10, machine: 'm1', ...over,
})
const meta = (m: Partial<LogRecord>, recordedAt: number, sha256 = 'a1', describer = 'D'): MetaRecord => ({ type: 'meta', sha256, meta: m, describer, recordedAt, machine: 'm2' })

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
  it('prefers the reading of the newer app version; with the same version, the later one', () => {
    const c = new Catalog()
    c.add(base())
    c.add(meta({ event: 'from 0.2.0' }, 20, 'a1', '0.2.0+aaaa'))
    c.add(meta({ event: 'from 0.1.0, later' }, 90, 'a1', '0.1.0+bbbb')) // written later by an older app
    expect(c.bySha('a1')!.event).toBe('from 0.2.0')
    c.add(meta({ event: 'from 0.2.0, rebuilt' }, 30, 'a1', '0.2.0+cccc'))
    expect(c.bySha('a1')!.event).toBe('from 0.2.0, rebuilt')
    c.add(meta({ event: 'from 0.10.0' }, 5, 'a1', '0.10.0+dddd')) // numeric, not text, order
    expect(c.bySha('a1')!.event).toBe('from 0.10.0')
    expect(newerReading(meta({}, 1, 'a1', ''), meta({}, 2, 'a1', '0.1.0'))).toBe(false) // a record naming no describer is the oldest
  })
  it('reads a meta line that names no describer (written by a build before the field)', () => {
    const { records } = parseManifest('{"type":"meta","sha256":"a1","meta":{"event":"TEST"},"recordedAt":3,"machine":"m"}\n')
    expect(records).toHaveLength(1)
  })
  it('takes only the describable fields from a meta, whatever else it carries', () => {
    const c = new Catalog()
    c.add(base({ sha256: 'a1' }))
    c.add(meta({ path: 'x', sha256: 'y', size: 1, names: ['z'], recordedAt: 99, machine: 'evil', md5: 'q', from: 'robot', modifiedTime: 5, event: 'TEST' } as never, 20))
    const r = c.bySha('a1')!
    expect(r).toEqual({ ...base({ sha256: 'a1' }), event: 'TEST' })
    expect(c.bySha('y')).toBeUndefined()
  })
  it('drops a meta field of the wrong shape and keeps the rest, without throwing', () => {
    const c = new Catalog()
    c.add(base())
    c.add(meta({ robot: 'Robot Z', build: { sha: 1, branch: 'x' }, code: { repo: '../..', linkedBy: 'sha', checkedAt: 1 }, event: 5, wall: { start: 'a', end: 2 }, matchType: '3', onField: 'yes', stub: 1, batteryId: 7, matchWindow: { start: 1, end: 2 }, matchNumber: 4 } as never, 20))
    const r = c.bySha('a1')!
    expect(r).toMatchObject({ robot: { profileId: 'p', name: 'Robot A' }, build: null, event: '', wall: null, matchType: null, onField: false, stub: false, batteryId: null })
    expect(r.code).toBeUndefined()
    expect(r).toMatchObject({ matchWindow: { start: 1, end: 2 }, matchNumber: 4 }) // the good fields still apply
    expect(() => facetValues(c.entries()[0], robotLabels(c.entries()))).not.toThrow()
    c.add(meta('not an object' as never, 30, 'a1', 'D2'))
    expect(c.bySha('a1')!.event).toBe('')
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
  // The resolution rules run on a table of invented events; the committed tables are only checked to load and agree with their files.
  const table = new Map([['abc', 'Test Regional'], ['xyz', 'Other Event'], ['qq', 'Quux Division']])
  it('resolves a code in any case', () => {
    expect(resolveIn(table, 'abc')).toBe('Test Regional')
    expect(resolveIn(table, 'ABC')).toBe('Test Regional')
    expect(resolveIn(table, ' Xyz ')).toBe('Other Event')
  })
  it('resolves a division word to the division\'s entry', () => {
    expect(resolveIn(table, 'QUUX')).toBe('Quux Division')
    expect(resolveIn(table, 'qq')).toBe('Quux Division')
    expect(resolveIn(table, 'Test')).toBeNull() // only "<Word> Division" entries are matched by word
  })
  it('resolves nothing for an empty string, an unknown code or a missing table', () => {
    expect(resolveIn(table, '')).toBeNull()
    expect(resolveIn(table, '  ')).toBeNull()
    expect(resolveIn(table, 'TEST')).toBeNull()
    expect(resolveIn(undefined, 'abc')).toBeNull()
  })
  const [code, name] = Object.entries(table2026).find(([k]) => !k.startsWith('_'))!
  it('loads the committed tables, by the year the log was played', () => {
    expect(eventTableYears()).toContain(2026)
    expect(resolveEvent(code.toUpperCase(), y(2026))).toBe(withYear(name, 2026))
    expect(withYear('Test Regional', 2026)).toBe('Test Regional 2026')
    expect(withYear('Test Regional 2025', 2026)).toBe('Test Regional 2025') // a name that already has a year keeps it
    expect(resolveEvent(code, null)).toBeNull()
    expect(resolveEvent('', y(2026))).toBeNull()
    expect(resolveEvent('_source', y(2026))).toBeNull()
    expect(resolveEvent(code, y(1990))).toBeNull() // no table for that year
    expect(Object.keys(table2026)).not.toContain('test') // the invented event of these tests resolves to nothing
    expect(resolveEvent('TEST', y(2026))).toBeNull()
  })
  it('names the place of an on-field log, falling back to the FMS text, and a typed place never overrides it', () => {
    expect(fmsPlace({ onField: true, event: code, playedAt: y(2026) })).toEqual({ name: withYear(name, 2026), resolved: true })
    expect(fmsPlace({ onField: true, event: 'TEST', playedAt: y(2026) })).toEqual({ name: 'TEST', resolved: false })
    expect(fmsPlace({ onField: false, event: code, playedAt: y(2026) })).toBeNull()
    const c = new Catalog()
    c.add(base({ onField: true, event: code }))
    c.add({ type: 'tag', target: { log: 'a1' }, field: 'place', value: 'Shop', recordedAt: 50, machine: 'm1' })
    expect(facetValues(c.entries()[0], robotLabels(c.entries())).place).toBe(withYear(name, new Date(c.entries()[0].record.playedAt!).getUTCFullYear()))
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
  it('keeps how the last job ended: its report, or its error', async () => {
    const runner = new JobRunner()
    expect(runner.lastFinished).toBeNull()
    await runner.run('Reading', async () => ({ added: [1, 2], skipped: 3 }))
    expect(runner.lastFinished).toMatchObject({ job: 'Reading', report: { added: [1, 2], skipped: 3 } })
    await expect(runner.run('Syncing', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(runner.lastFinished).toMatchObject({ job: 'Syncing', error: 'offline' })
    expect(runner.lastFinished!.report).toBeUndefined()
    await expect(runner.run('Another', async () => 1, () => {})).resolves.toBe(1)
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
      if (name === 'a.wpilog') return { ...real, meta: { ...real.meta, event: 'TEST', robot: { profileId: null, name: 'TestCode', how: 'signals', fit: 0.1 }, playedAt: 1, kind: 'dslog' } }
      if (name === 'e.wpilog') return { ...real, sha256: 'f'.repeat(64) }
      return real
    }
    const seen: string[] = []
    const report = await redescribe(lib, { describer: 'T1', describe: fake, onProgress: (_d, _t, current) => seen.push(current) })
    expect(report).toEqual({
      wpilogs: 5, changed: 1, unchanged: 1, skipped: 0, missing: 1,
      failed: [{ path: pathOf('d'), reason: 'unreadable test log' }, { path: pathOf('e'), reason: expect.stringContaining('sha-256') }],
    })
    expect(seen.at(-1)).toBe('')
    const after = await manifestLines()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 2) // the changed log, and b stamped as read by this describer
    const written = after.slice(before.length).map((l) => JSON.parse(l) as MetaRecord).find((m) => m.sha256 === record('a').sha256)!
    expect(written).toMatchObject({ type: 'meta', sha256: record('a').sha256, machine: 'm1' })
    // The fields that decide where the file lives are not in what was written, and the catalog keeps them.
    expect(Object.keys(written.meta)).not.toContain('playedAt')
    expect(Object.keys(written.meta)).not.toContain('kind')
    const a = lib.catalog.bySha(record('a').sha256)!
    expect(a).toMatchObject({ event: 'TEST', kind: 'wpilog', dateSource: 'robot clock' })
    expect(a.robot).toEqual({ profileId: null, name: 'TestCode', how: 'signals', fit: 0.1 })
    expect(a.playedAt).not.toBe(1)
    // A fresh open of the library reads the same.
    const reopened = await LocalLibrary.open(libRoot, 'm1')
    expect(reopened.catalog.bySha(a.sha256)).toEqual(a)
  })

  it('finds nothing to change the second time', async () => {
    const before = await manifestLines()
    const same = await redescribe(lib, { describer: 'T1', describe: async (path, name) => {
      const real = await describeFile(path, name)
      return name === 'a.wpilog' ? { ...real, meta: { ...real.meta, event: 'TEST', robot: { profileId: null, name: 'TestCode', how: 'signals', fit: 0.1 } } } : real
    } })
    expect(same).toMatchObject({ wpilogs: 5, changed: 0, unchanged: 2, skipped: 2, missing: 1, failed: [] }) // a and b are skipped; d and e failed before, so they are read now
    const after = await manifestLines()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after).toHaveLength(before.length + 2) // d and e could be read this time: stamped, not changed
    expect((await redescribe(lib, { describer: 'T1', describe: describeFile })).skipped).toBe(4) // a third run reads nothing
    expect(await manifestLines()).toEqual(after)
  })

  it('carries a code link through a later re-reading by another describer', async () => {
    const a = lib.catalog.all().find((r) => r.names[0] === 'a.wpilog')!
    const code = { repo: 'testorg/robot-main', linkedBy: 'codebase' as const, checkedAt: 5 }
    // What linking code writes: the log's current reading plus the link, naming the describer it copied.
    await lib.append({ type: 'meta', sha256: a.sha256, meta: { ...readingOf(a), code }, describer: lib.catalog.metaOf(a.sha256)!.describer, recordedAt: Date.now(), machine: lib.machine })
    expect(lib.catalog.bySha(a.sha256)!.code).toEqual(code)
    expect((await redescribe(lib, { describer: 'T1', describe: describeFile })).skipped).toBe(4) // the link did not make it look unread
    const report = await redescribe(lib, { describer: 'T2', describe: async (path, name) => {
      const real = await describeFile(path, name)
      return name === 'a.wpilog' ? { ...real, meta: { ...real.meta, event: 'again' } } : real
    } })
    expect(report).toMatchObject({ changed: 1, unchanged: 3, skipped: 0 })
    const now = lib.catalog.bySha(a.sha256)!
    expect(now).toMatchObject({ event: 'again', code })
    expect(lib.catalog.metaOf(a.sha256)!.describer).toBe('T2')
    expect((await LocalLibrary.open(libRoot, 'm1')).catalog.bySha(a.sha256)).toEqual(now)
  })

  it('sees a record another process appended to this machine\'s own manifest, after reload', async () => {
    const other = await LocalLibrary.open(libRoot, 'm1') // a second process on the same library
    const a = other.catalog.all().find((r) => r.names[0] === 'a.wpilog')!
    await other.append({ type: 'meta', sha256: a.sha256, meta: { event: 'from another process' }, describer: 'T3', recordedAt: Date.now(), machine: 'm1' })
    expect(lib.catalog.bySha(a.sha256)!.event).toBe('again')
    await lib.reload()
    expect(lib.catalog.bySha(a.sha256)!.event).toBe('from another process')
    // Appending after a reload continues the file that is on disk, not an older copy of it.
    await lib.append({ type: 'meta', sha256: a.sha256, meta: { event: 'then this' }, describer: 'T3', recordedAt: Date.now(), machine: 'm1' })
    const lines = await manifestLines()
    expect(lines.filter((l) => l.includes('from another process') || l.includes('then this'))).toHaveLength(2)
    expect(lib.ownLines()).toEqual(lines)
  })

  it('skips a log read by a newer app version', async () => {
    const a = lib.catalog.all().find((r) => r.names[0] === 'b.wpilog')!
    await lib.append({ type: 'meta', sha256: a.sha256, meta: readingOf(a), describer: '9.0.0+future', recordedAt: Date.now(), machine: 'm2' })
    const report = await redescribe(lib, { describer: '0.1.0+old', describe: async () => { throw new Error('should not be read') } })
    expect(report.failed.filter((f) => f.path === a.path)).toEqual([])
    expect(report.skipped).toBeGreaterThanOrEqual(1)
    expect(lib.catalog.metaOf(a.sha256)!.describer).toBe('9.0.0+future')
  })

  it('writes a link only when it is new or different, naming a describer, never an empty one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hindsight-links-'))
    try {
      const l = await LocalLibrary.open(dir, 'm1')
      const rec = (sha256: string): LogRecord => ({ ...base({ sha256, path: `logs/x/${sha256}.wpilog`, names: [`${sha256}.wpilog`] }) })
      await l.append(rec('s1'), rec('s2'))
      await l.append({ type: 'meta', sha256: 's2', meta: {}, describer: '0.1.0+earlier', recordedAt: 5, machine: 'm1' })
      const link = { repo: 'testorg/robot-main', linkedBy: 'codebase' as const, checkedAt: 100 }
      const lines = async () => (await readFile(join(dir, l.ownManifestPath), 'utf8')).split('\n').filter(Boolean).length
      const before = await lines()
      expect(await applyLinks(l, new Map([['s1', link], ['s2', link], ['missing', link]]), '0.1.0+now', () => 200)).toEqual({ written: 2, unchanged: 0 })
      expect(await lines()).toBe(before + 2)
      expect(l.catalog.metaOf('s1')!.describer).toBe('0.1.0+now') // no meta before: this build's id
      expect(l.catalog.metaOf('s2')!.describer).toBe('0.1.0+earlier') // the reading it copied
      expect(l.catalog.bySha('s1')!.code).toEqual(link)
      // The same link found again (only checkedAt differs) writes nothing; a different one does.
      expect(await applyLinks(l, new Map([['s1', { ...link, checkedAt: 999 }]]), '0.1.0+now')).toEqual({ written: 0, unchanged: 1 })
      expect(await lines()).toBe(before + 2)
      expect(await applyLinks(l, new Map([['s1', { ...link, repo: 'testorg/other', checkedAt: 999 }]]), '0.1.0+now')).toEqual({ written: 1, unchanged: 0 })
      expect(l.catalog.bySha('s1')!.code!.repo).toBe('testorg/other')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('stops when cancelled', async () => {
    let calls = 0
    const report = await redescribe(lib, { describer: 'T1', describe: describeFile, cancelled: () => calls++ >= 1 })
    expect(report.changed + report.unchanged + report.missing + report.failed.length).toBeLessThan(5)
  })
})
