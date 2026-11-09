// Two machines, one team store: upload, publish, download, dedupe by content, a failed upload, a re-run, a foreign manifest,
// and Drive to Drive (listing checksums, one download, a server-side copy).
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { DriveAdapter } from '../src/hub/drive-adapter.ts'
import { driveFolderFiles } from '../src/hub/drive-source.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { ingest, localFolderFiles, planIngest } from '../src/hub/ingest.ts'
import { FAILURES_IN_A_ROW, fetchLogs, matchesFirst, planSync, syncWithTeam } from '../src/hub/sync.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { SignInAgain, readText } from '../src/hub/adapter.ts'
import { parseManifest } from '../src/hub/types.ts'
import { robotLog } from './helpers/hub-logs.ts'
import { FakeDrive } from './helpers/fake-drive.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0)
let work: string
const options = { describe: describeFile }

async function putLog(dir: string, rel: string, seed: string, clock = CLOCK) {
  const path = join(dir, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, robotLog({ clockMs: clock, enabled: [20, 55], event: 'TEST', fms: true, matchType: 2, matchNumber: 1, seed }))
  const t = new Date(clock)
  await utimes(path, t, t)
}

async function machine(name: string): Promise<LocalLibrary> {
  return LocalLibrary.open(join(work, name), name)
}

beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-sync-')) })
afterEach(() => rm(work, { recursive: true, force: true }))

describe('sync through a team store', () => {
  it('uploads what the team lacks, publishes the records, and a teammate sees every log and downloads one on demand', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await putLog(join(work, 'srcA'), 'one.wpilog', 'one')
    await putLog(join(work, 'srcA'), 'two.wpilog', 'two', CLOCK + 3600e3)
    await ingest(a, await localFolderFiles(join(work, 'srcA')), options)
    const bytes = a.catalog.all().reduce((n, r) => n + r.size, 0)
    expect(await planSync(a, team)).toEqual({ uploads: 2, uploadBytes: bytes, copies: 0 })
    const report = await syncWithTeam(a, team)
    expect(report.uploaded.map((u) => u.how)).toEqual(['upload', 'upload'])
    expect(await planSync(a, team)).toEqual({ uploads: 0, uploadBytes: 0, copies: 0 }) // the next sync asks nothing
    expect(report.failed).toEqual([])
    expect((await team.list('logs')).length).toBe(2)
    expect(parseManifest((await readText(team, 'manifests/ma.jsonl'))!).records.filter((r) => r.type === 'log').length).toBe(2)
    expect(team.files.get(a.catalog.all()[0].path)!.modifiedTime).toBeGreaterThan(0)

    const b = await machine('mb')
    const synced = await syncWithTeam(b, team)
    expect(synced.manifests).toEqual([{ name: 'manifests/ma.jsonl', records: 2 }])
    expect(synced.uploaded).toEqual([])
    expect(b.catalog.size).toBe(2)
    expect(await b.store.stat(b.catalog.all()[0].path)).toBeNull() // known, not downloaded
    const want = b.catalog.all().filter((r) => r.names[0] === 'one.wpilog')
    const got = await fetchLogs(b, team, want)
    expect(got.fetched).toEqual([want[0].path])
    expect((await b.store.stat(want[0].path))!.size).toBe(want[0].size)
    expect((await readdir(join(b.root, 'logs/2026-2027/2026-10-17'))).filter((n) => n.endsWith('.part'))).toEqual([])
  })

  it('uploads the newest played log first, even when it was added last', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await putLog(join(work, 'old'), 'old.wpilog', 'old', CLOCK - 30 * 86400e3)
    await ingest(a, await localFolderFiles(join(work, 'old')), options)
    await putLog(join(work, 'new'), 'new.wpilog', 'new', CLOCK)
    await putLog(join(work, 'new'), 'mid.wpilog', 'mid', CLOCK - 86400e3)
    await ingest(a, await localFolderFiles(join(work, 'new')), options)
    const names = new Map(a.catalog.all().map((r) => [r.path, r.names[0]]))
    const report = await syncWithTeam(a, team)
    expect(report.uploaded.map((u) => names.get(u.path))).toEqual(['new.wpilog', 'mid.wpilog', 'old.wpilog'])
  })

  it('ranks match logs, then other dated logs, then undated ones, each newest first, and keeps the order they came in on a tie', () => {
    const at = (name: string, playedAt: number | null, recordedAt: number, extra: object = {}) => ({ names: [name], playedAt, recordedAt, matchType: null, onField: false, ...extra }) as Parameters<typeof matchesFirst>[0]
    const sorted = [
      at('old', 1, 10), at('undated-added-now', null, 10), at('undated-added-early', null, 0), at('new', 3, 10), at('also-new', 3, 10),
      at('old-quals', 0, 10, { matchType: 2 }), at('field-practice', -5, 10, { onField: true }), at('newer-quals', 2, 10, { matchType: 2 }),
    ].sort(matchesFirst)
    expect(sorted.map((r) => r.names[0])).toEqual(['newer-quals', 'old-quals', 'field-practice', 'new', 'also-new', 'old', 'undated-added-now', 'undated-added-early'])
  })

  // Item 2 of the low-bandwidth plan: an undated log added after a match, even one added later than the match was played, goes last.
  it('uploads a match log before a dated practice log before an undated one, whatever the order they were added in', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    const dir = join(work, 'bands')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'match.wpilog'), robotLog({ clockMs: CLOCK - 10 * 86400e3, enabled: [20, 55], event: 'TEST', fms: true, matchType: 2, matchNumber: 1, seed: 'band-m' }))
    await writeFile(join(dir, 'practice.wpilog'), robotLog({ clockMs: CLOCK, enabled: [20, 55], seed: 'band-p' }))
    await ingest(a, await localFolderFiles(dir), options)
    const dir2 = join(work, 'bands2')
    await mkdir(dir2, { recursive: true })
    await writeFile(join(dir2, 'undated.wpilog'), robotLog({ enabled: [20, 55], seed: 'band-u' }))
    await ingest(a, await localFolderFiles(dir2), options)
    const names = new Map(a.catalog.all().map((r) => [r.path, r.names[0]]))
    expect([...names.values()].sort()).toEqual(['match.wpilog', 'practice.wpilog', 'undated.wpilog'])
    const report = await syncWithTeam(a, team)
    expect(report.uploaded.map((u) => names.get(u.path))).toEqual(['match.wpilog', 'practice.wpilog', 'undated.wpilog'])
  })

  it('a second sync writes nothing', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await putLog(join(work, 'src'), 'one.wpilog', 'one')
    await ingest(a, await localFolderFiles(join(work, 'src')), options)
    await syncWithTeam(a, team)
    const writes = team.writes.length
    const again = await syncWithTeam(a, team)
    expect(again.uploaded).toEqual([])
    expect(again.alreadyThere).toBe(1)
    expect(team.writes.length).toBe(writes)
  })

  it('a failed upload leaves no record on the team store, keeps the local copy, and the next sync finishes it', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await putLog(join(work, 'src'), 'one.wpilog', 'one')
    await ingest(a, await localFolderFiles(join(work, 'src')), options)
    team.failUploadAfter = 0
    const bad = await syncWithTeam(a, team)
    expect(bad.failed.length).toBe(1)
    expect(bad.uploaded).toEqual([])
    expect(team.files.size === 0 || [...team.files.keys()].every((k) => k.startsWith('manifests/'))).toBe(true)
    expect(parseManifest((await readText(team, 'manifests/ma.jsonl')) ?? '').records.filter((r) => r.type === 'log')).toEqual([])
    expect(await a.store.stat(a.catalog.all()[0].path)).not.toBeNull()
    const ok = await syncWithTeam(a, team)
    expect(ok.uploaded.length).toBe(1)
    expect(parseManifest((await readText(team, 'manifests/ma.jsonl'))!).records.filter((r) => r.type === 'log').length).toBe(1)
  })

  it('the same bytes brought in by a second machine under another name are one log with both names, and not uploaded twice', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await putLog(join(work, 'srcA'), 'one.wpilog', 'one')
    await ingest(a, await localFolderFiles(join(work, 'srcA')), options)
    await syncWithTeam(a, team)
    const b = await machine('mb')
    await syncWithTeam(b, team)
    await putLog(join(work, 'srcB'), 'my-name.wpilog', 'one')
    const rep = await ingest(b, await localFolderFiles(join(work, 'srcB')), options)
    expect(rep.added).toEqual([])
    expect(rep.already[0]).toMatchObject({ name: 'my-name.wpilog', newName: true })
    const synced = await syncWithTeam(b, team)
    expect(synced.uploaded).toEqual([])
    expect(b.catalog.namesOf(b.catalog.all()[0].sha256).sort()).toEqual(['my-name.wpilog', 'one.wpilog'])
    // Tags travel too.
    await b.append({ type: 'tag', target: { day: '2026-10-17' }, field: 'place', value: 'Shop', recordedAt: Date.now(), machine: 'mb' })
    await syncWithTeam(b, team)
    await syncWithTeam(a, team)
    expect(a.catalog.entries()[0].tags.place).toBe('Shop')
  })

  it("refuses to publish when the team's copy of its manifest holds records this copy lacks", async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await putLog(join(work, 'src'), 'one.wpilog', 'one')
    await ingest(a, await localFolderFiles(join(work, 'src')), options)
    team.put('manifests/ma.jsonl', '{"type":"tag","target":{"day":"x"},"field":"place","value":"elsewhere","recordedAt":1,"machine":"ma"}\n')
    const rep = await syncWithTeam(a, team)
    expect(rep.problems[0]).toMatch(/another install/)
    expect(rep.uploaded).toEqual([])
    expect([...team.files.keys()].filter((k) => k.startsWith('logs/'))).toEqual([])
  })

  it('does not call a file there, or publish its record, when its checksum differs from the log (a corrupted upload keeps its size)', async () => {
    const team = new MemoryAdapter()
    const a = await machine('ma')
    await putLog(join(work, 'src'), 'one.wpilog', 'one')
    await ingest(a, await localFolderFiles(join(work, 'src')), options)
    const record = a.catalog.all()[0]
    team.put(record.path, new Uint8Array(record.size).fill(7)) // same size, other bytes
    const rep = await syncWithTeam(a, team)
    expect(rep.uploaded).toEqual([])
    expect(rep.failed).toEqual([expect.objectContaining({ path: record.path, reason: expect.stringMatching(/different file/) })])
    expect(parseManifest((await readText(team, 'manifests/ma.jsonl')) ?? '').records.filter((r) => r.type === 'log')).toEqual([])
  })

  it('lists files in the team folder that no manifest mentions', async () => {
    const team = new MemoryAdapter()
    team.put('logs/2026-2027/2026-10-17/by-hand.wpilog', 'x')
    const a = await machine('ma')
    expect((await syncWithTeam(a, team)).unrecorded).toEqual(['logs/2026-2027/2026-10-17/by-hand.wpilog'])
  })
})

describe('Drive to Drive', () => {
  it('lists a Drive folder with checksums, downloads each log once, files it, and copies it inside Drive when syncing', async () => {
    const drive = new FakeDrive()
    const adapter = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const teamFolder = drive.addFolder('root', 'team-folder')
    const old = drive.addFolder('root', 'old logs')
    const sub = drive.addFolder(old, 'practice')
    const logA = robotLog({ clockMs: CLOCK, enabled: [20, 55], seed: 'da' })
    const logB = robotLog({ clockMs: CLOCK + 3600e3, enabled: [20, 55], seed: 'db' })
    drive.addFile(sub, 'one.wpilog', logA)
    drive.addFile(old, 'same bytes.wpilog', logA)
    drive.addFile(old, 'two.wpilog', logB)
    drive.addFile(old, 'readme.txt', 'x')
    const team = new DriveAdapter({ rootId: teamFolder, token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })

    const a = await machine('ma')
    const source = new DriveAdapter({ rootId: old, token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const files = await driveFolderFiles(source, old, work)
    const plan = planIngest(a, files)
    expect(plan).toMatchObject({ logs: 3, alreadyKnown: 0, toRead: 3, ignored: 1 })
    expect(plan.bytesToRead).toBe(logA.length * 2 + logB.length)

    const report = await ingest(a, files, options)
    expect(report.added.length).toBe(2)
    expect(report.already.length).toBe(1) // the same bytes under another name: known from Drive's checksum once the first copy is filed, so not downloaded
    expect(report.unreadable).toEqual([])
    expect(source.calls.download).toBe(2) // one per distinct content, the whole file each
    const downloads = source.calls.download

    // Again: every checksum is known, so nothing is downloaded.
    const again = await ingest(a, await driveFolderFiles(source, old, work), options)
    expect(again.added).toEqual([])
    expect(source.calls.download).toBe(downloads)
    expect(planIngest(a, await driveFolderFiles(source, old, work))).toMatchObject({ alreadyKnown: 3, toRead: 0, bytesToRead: 0 })

    expect(await planSync(a, team)).toEqual({ uploads: 0, uploadBytes: 0, copies: 2 }) // no bytes leave this computer
    const synced = await syncWithTeam(a, team)
    expect(synced.uploaded.map((u) => u.how)).toEqual(['copy inside Drive', 'copy inside Drive'])
    expect(team.calls.copy).toBe(2)
    expect(team.calls.upload).toBe(1) // the manifest only
    expect(drive.at('team-folder/logs/2026-2027/2026-10-17/one.wpilog')?.bytes?.length).toBe(logA.length)
    expect(drive.at('old logs/practice/one.wpilog')).toBeDefined() // the originals stay
    expect((await stat(a.store.at(a.catalog.all()[0].path))).size).toBeGreaterThan(0)
  })

  // A Drive-sourced log is only ever copied: a refused or wrong copy fails that log instead of uploading it.
  async function copiedOnce(seed: string) {
    const drive = new FakeDrive()
    const teamFolder = drive.addFolder('root', 'team-folder')
    const old = drive.addFolder('root', 'old logs')
    drive.addFile(old, 'one.wpilog', robotLog({ clockMs: CLOCK, enabled: [20, 55], seed }))
    const mk = (root: string) => new DriveAdapter({ rootId: root, token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const a = await machine('ma')
    await ingest(a, await driveFolderFiles(mk(old), old, work), options)
    return { a, team: mk(teamFolder) }
  }
  const ownLogsIn = async (team: DriveAdapter, a: LocalLibrary) =>
    parseManifest((await readText(team, a.ownManifestPath)) ?? '').records.filter((r) => r.type === 'log').length

  it('fails a log whose copy inside Drive is refused, without uploading it or publishing its record', async () => {
    const { a, team } = await copiedOnce('x')
    team.copyInto = async () => { throw new Error('403') }
    const synced = await syncWithTeam(a, team)
    expect(synced.uploaded).toEqual([])
    expect(synced.failed).toEqual([{ path: a.catalog.all()[0].path, reason: '403' }])
    expect(team.calls.upload).toBe(0) // no log, and no manifest: it would have held nothing
    expect(await ownLogsIn(team, a)).toBe(0)
  })

  it('fails a log whose copy inside Drive reports other checksums; the next sync, finding the right bytes there, publishes it', async () => {
    const { a, team } = await copiedOnce('y')
    const copy = team.copyInto!.bind(team)
    team.copyInto = async (id, path) => ({ ...(await copy(id, path)), sha256: '0'.repeat(64) })
    const synced = await syncWithTeam(a, team)
    expect(synced.uploaded).toEqual([])
    expect(synced.failed.map((f) => f.reason)).toEqual([expect.stringContaining('not the library')])
    expect(await ownLogsIn(team, a)).toBe(0)
    // Drive itself holds the right bytes here, so the next sync finds the file there and publishes it.
    team.copyInto = copy
    expect((await syncWithTeam(a, team)).failed).toEqual([])
    expect(await ownLogsIn(team, a)).toBe(1)
  })

  it('fails a log whose copy really holds other bytes, and leaves it unpublished on every later sync', async () => {
    const drive = new FakeDrive()
    const teamFolder = drive.addFolder('root', 'team-folder')
    const old = drive.addFolder('root', 'old logs')
    drive.addFile(old, 'one.wpilog', robotLog({ clockMs: CLOCK, enabled: [20, 55], seed: 'w' }))
    const otherId = drive.addFile(old, 'other.wpilog', robotLog({ clockMs: CLOCK + 3600e3, enabled: [20, 55], seed: 'z' }))
    const mk = (root: string) => new DriveAdapter({ rootId: root, token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const a = await machine('ma')
    const source = mk(old)
    await ingest(a, (await driveFolderFiles(source, old, work)).filter((f) => f.name === 'one.wpilog'), options)
    const team = mk(teamFolder)
    const copy = team.copyInto!.bind(team)
    team.copyInto = async (_id, path) => copy(otherId, path) // the source id now names a different file
    const first = await syncWithTeam(a, team)
    expect(first.failed.map((f) => f.reason)).toEqual([expect.stringContaining('not the library')])
    const second = await syncWithTeam(a, team)
    expect(second.failed.map((f) => f.reason)).toEqual([expect.stringContaining('different file at this path')])
    expect(await ownLogsIn(team, a)).toBe(0)
    expect(team.calls.upload).toBe(0)
  })

  it('fails a log whose copy Drive reports without checksums, then publishes it once the listing has them', async () => {
    const { a, team } = await copiedOnce('v')
    const copy = team.copyInto!.bind(team)
    team.copyInto = async (id, path) => { const { sha256: _s, md5: _m, ...bare } = await copy(id, path); return bare }
    expect((await syncWithTeam(a, team)).failed.map((f) => f.reason)).toEqual([expect.stringContaining('no checksum')])
    expect(await ownLogsIn(team, a)).toBe(0)
    expect((await syncWithTeam(a, team)).failed).toEqual([])
    expect(await ownLogsIn(team, a)).toBe(1)
  })

  // Several failures in a row mean something systemic (a rate limit run out, a lost sign-in): stop instead of spending
  // a minute of back-off on every remaining log.
  async function copiedMany(n: number) {
    const drive = new FakeDrive()
    const teamFolder = drive.addFolder('root', 'team-folder')
    const old = drive.addFolder('root', 'old logs')
    for (let i = 0; i < n; i++) drive.addFile(old, `log${i}.wpilog`, robotLog({ clockMs: CLOCK + i * 3600e3, enabled: [20, 55], seed: `m${i}` }))
    const mk = (root: string) => new DriveAdapter({ rootId: root, token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const a = await machine('ma')
    await ingest(a, await driveFolderFiles(mk(old), old, work), options)
    return { a, team: mk(teamFolder) }
  }

  it(`stops after ${FAILURES_IN_A_ROW} failures in a row, leaves the rest untried, says so, and still publishes what landed`, async () => {
    const { a, team } = await copiedMany(FAILURES_IN_A_ROW + 3)
    const copy = team.copyInto!.bind(team)
    let tries = 0
    team.copyInto = async (id, path) => { if (++tries === 1) return copy(id, path); throw new Error('429') }
    const synced = await syncWithTeam(a, team)
    expect(tries).toBe(1 + FAILURES_IN_A_ROW)
    expect(synced.uploaded.length).toBe(1)
    expect(synced.failed.length).toBe(FAILURES_IN_A_ROW)
    expect(synced.problems).toEqual([`Stopped after ${FAILURES_IN_A_ROW} failures in a row (the last: 429); 2 logs not tried: run sync again`])
    expect(await ownLogsIn(team, a)).toBe(1)
    team.copyInto = copy // the next sync tries the rest
    const again = await syncWithTeam(a, team)
    expect(again.uploaded.length).toBe(FAILURES_IN_A_ROW + 2)
    expect(again.problems).toEqual([])
  })

  it('a log that lands between failures starts the count again', async () => {
    const { a, team } = await copiedMany(2 * FAILURES_IN_A_ROW)
    const copy = team.copyInto!.bind(team)
    let tries = 0
    team.copyInto = async (id, path) => { if (++tries % FAILURES_IN_A_ROW === 0) return copy(id, path); throw new Error('403') }
    const synced = await syncWithTeam(a, team)
    expect(tries).toBe(2 * FAILURES_IN_A_ROW)
    expect(synced.failed.length).toBe(2 * (FAILURES_IN_A_ROW - 1))
    expect(synced.problems).toEqual([])
  })

  it('the last log failing fifth in a row says it stopped, and names no logs left untried', async () => {
    const { a, team } = await copiedMany(FAILURES_IN_A_ROW)
    team.copyInto = async () => { throw new Error('403') }
    expect((await syncWithTeam(a, team)).problems).toEqual([`Stopped after ${FAILURES_IN_A_ROW} failures in a row (the last: 403)`])
  })

  it('a lost sign-in ends the sync at once with its own error instead of counting as a failed log', async () => {
    const { a, team } = await copiedMany(FAILURES_IN_A_ROW + 1)
    let tries = 0
    team.copyInto = async () => { tries++; throw new SignInAgain() }
    await expect(syncWithTeam(a, team)).rejects.toBeInstanceOf(SignInAgain)
    expect(tries).toBe(1)
  })
})

// Items 1, 3 and 4 of the low-bandwidth plan.
describe('publishing as logs land, skipping unchanged files, and downloading in order', () => {
  /** A MemoryAdapter that lets a test look at the store while a write is in flight, and counts reads per path. */
  class Spy extends MemoryAdapter {
    beforeWrite: ((n: number, path: string) => Promise<void>) | null = null
    reads: string[] = []
    private n = 0
    override async writeNew(...args: Parameters<MemoryAdapter['writeNew']>) {
      if (args[0].startsWith('logs/')) await this.beforeWrite?.(++this.n, args[0])
      return super.writeNew(...args)
    }
    override async read(path: string, start: number, end: number) { this.reads.push(path); return super.read(path, start, end) }
  }

  /** n dated match logs in one machine, played an hour apart (the last played is uploaded first). */
  async function manyLogs(n: number, name = 'ma') {
    const a = await machine(name)
    const dir = join(work, `many-${name}`)
    for (let i = 0; i < n; i++) await putLog(dir, `log${i}.wpilog`, `${name}-${i}`, CLOCK + i * 3600e3)
    await ingest(a, await localFolderFiles(dir), options)
    return a
  }
  const logsIn = async (team: MemoryAdapter, m: string) => parseManifest((await readText(team, `manifests/${m}.jsonl`)) ?? '').records.filter((r) => r.type === 'log').length
  /** A clock that moves 200 s on every reading, so every upload is past the 120 s publish gap. */
  const fastClock = () => { let t = 0; return () => (t += 200_000) }

  it('shows a teammate record N while upload N+1 is still in flight', async () => {
    const team = new Spy()
    const a = await manyLogs(3)
    const seen: number[] = []
    team.beforeWrite = async (n) => { seen.push(await logsIn(team, 'ma')); void n }
    const report = await syncWithTeam(a, team, { now: fastClock() })
    expect(seen).toEqual([0, 1, 2])
    expect(report.published).toBe(3)
    expect(await logsIn(team, 'ma')).toBe(3)
  })

  it('publishes not before the gap (119 s: no, 120 s: yes), and still publishes everything at the end', async () => {
    const team = new Spy()
    const a = await manyLogs(4)
    const seen: number[] = []
    let t = 0
    const at = [0, 119_000, 120_000, 120_000]
    team.beforeWrite = async (n) => { t = at[n - 1]; seen.push(await logsIn(team, 'ma')) }
    const report = await syncWithTeam(a, team, { now: () => t })
    expect(seen).toEqual([0, 0, 0, 3])
    expect(report.published).toBe(4)
    expect(await logsIn(team, 'ma')).toBe(4)
  })

  it('a periodic publish that fails with a plain error is one problem, not a failed log, and the logs after it are published', async () => {
    class Flaky extends Spy {
      calls = 0
      override async appendManifest(path: string, content: string) {
        if (path.startsWith('manifests/') && ++this.calls === 1) throw new Error('503')
        return super.appendManifest(path, content)
      }
    }
    const team = new Flaky()
    const a = await manyLogs(4)
    const report = await syncWithTeam(a, team, { now: (() => { let t = 0; return () => (t += 200_000) })() })
    expect(report.uploaded.length).toBe(4)
    expect(report.failed).toEqual([])
    expect(report.problems.length).toBe(1)
    expect(report.problems[0]).toContain('publishing failed (503)')
    expect(report.published).toBe(4)
    expect(await logsIn(team, 'ma')).toBe(4)
  })

  it('a failing final publish is a problem in the report, not a thrown job', async () => {
    class Down extends Spy { override async appendManifest(): Promise<void> { throw new Error('503') } }
    const team = new Down()
    const a = await manyLogs(2)
    const report = await syncWithTeam(a, team)
    expect(report.uploaded.length).toBe(2)
    expect(report.problems).toEqual([expect.stringContaining('publishing failed (503)')])
    expect(report.published).toBe(0)
  })

  it('two periodic publishes whose eligibility is out of local order append without a conflict', async () => {
    const team = new Spy()
    const a = await manyLogs(3) // local order log0, log1, log2; uploaded log2, log1, log0
    const report = await syncWithTeam(a, team, { now: fastClock() })
    expect(report.problems).toEqual([])
    expect(team.writes.filter((w) => w === 'manifests/ma.jsonl').length).toBe(3)
    expect(report.published).toBe(3)
    const names = new Map(a.catalog.all().map((r) => [r.sha256, r.names[0]]))
    const order = parseManifest((await readText(team, 'manifests/ma.jsonl'))!).records.filter((r) => r.type === 'log').map((r) => names.get((r as { sha256: string }).sha256))
    expect(order).toEqual(['log2.wpilog', 'log1.wpilog', 'log0.wpilog'])
  })

  it('a conflict in the middle stops later publishes, keeps uploading, and reports what was published', async () => {
    const team = new Spy()
    const a = await manyLogs(3)
    team.beforeWrite = async (n) => { if (n === 3) team.put('manifests/ma.jsonl', `${await readText(team, 'manifests/ma.jsonl')}{"type":"alias","foreign":true}\n`) }
    const report = await syncWithTeam(a, team, { now: fastClock() })
    expect(report.uploaded.length).toBe(3)
    expect(report.problems.length).toBe(1)
    expect(report.problems[0]).toContain('changed on the team store while syncing')
    expect(report.published).toBe(2)
  })

  it('does not download a teammate manifest that has not changed, and does when it has', async () => {
    const team = new Spy()
    const a = await manyLogs(1, 'ma')
    await syncWithTeam(a, team)
    const b = await machine('mb')
    await syncWithTeam(b, team)
    expect(b.catalog.size).toBe(1)
    team.reads = []
    const again = await syncWithTeam(b, team)
    expect(again.manifests).toEqual([])
    expect(team.reads.filter((p) => p === 'manifests/ma.jsonl')).toEqual([])
    // the teammate adds a log: the manifest changed, so it is downloaded (once) and its record arrives
    await putLog(join(work, 'more'), 'more.wpilog', 'more', CLOCK + 99 * 3600e3)
    await ingest(a, await localFolderFiles(join(work, 'more')), options)
    await syncWithTeam(a, team)
    team.reads = []
    const third = await syncWithTeam(b, team)
    expect(third.manifests).toEqual([{ name: 'manifests/ma.jsonl', records: 1 }])
    expect(team.reads.filter((p) => p === 'manifests/ma.jsonl').length).toBe(1)
  })

  it('a new Drive adapter on the same folder does not download this machine\'s own manifest that the last sync wrote, and does when it changed', async () => {
    const drive = new FakeDrive()
    const folder = drive.addFolder('root', 'own-team')
    const mk = () => new DriveAdapter({ rootId: folder, token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const a = await manyLogs(2)
    await syncWithTeam(a, mk())
    await putLog(join(work, 'own-more'), 'own-more.wpilog', 'own-more', CLOCK + 50 * 3600e3)
    await ingest(a, await localFolderFiles(join(work, 'own-more')), options)
    const second = mk()
    const report = await syncWithTeam(a, second)
    expect(report.problems).toEqual([])
    expect(second.calls.download).toBe(0)
    // another process appended a line: the md5 differs, so it is read and found to hold what this copy lacks
    const node = drive.at('own-team/manifests/ma.jsonl')!
    node.bytes = new TextEncoder().encode(`${new TextDecoder().decode(node.bytes!)}{"type":"alias","foreign":true}\n`)
    const third = mk()
    const again = await syncWithTeam(a, third)
    expect(third.calls.download).toBeGreaterThan(0)
    expect(again.problems.join()).toContain('holds records this copy lacks')
  })

  it('downloads match logs first and newest first, whatever order it is given', async () => {
    const team = new Spy()
    const a = await machine('ma')
    const dir = join(work, 'dl')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'match.wpilog'), robotLog({ clockMs: CLOCK - 10 * 86400e3, enabled: [20, 55], event: 'TEST', fms: true, matchType: 2, matchNumber: 1, seed: 'dl-m' }))
    await writeFile(join(dir, 'practice.wpilog'), robotLog({ clockMs: CLOCK, enabled: [20, 55], seed: 'dl-p' }))
    await writeFile(join(dir, 'undated.wpilog'), robotLog({ enabled: [20, 55], seed: 'dl-u' }))
    await ingest(a, await localFolderFiles(dir), options)
    await syncWithTeam(a, team)
    const b = await machine('mb')
    await syncWithTeam(b, team)
    const names = new Map(b.catalog.all().map((r) => [r.path, r.names[0]]))
    const report = await fetchLogs(b, team, [...b.catalog.all()].reverse().sort((x, y) => (x.names[0] < y.names[0] ? 1 : -1)))
    expect(report.fetched.map((p) => names.get(p))).toEqual(['match.wpilog', 'practice.wpilog', 'undated.wpilog'])
    expect(report.problems).toEqual([])
  })

  it(`stops downloading after ${FAILURES_IN_A_ROW} failures in a row and says how many were not tried`, async () => {
    const team = new Spy()
    const a = await manyLogs(FAILURES_IN_A_ROW + 2)
    await syncWithTeam(a, team)
    const b = await machine('mb')
    await syncWithTeam(b, team)
    let tries = 0
    team.read = async () => { tries++; throw new Error('429') }
    const report = await fetchLogs(b, team, b.catalog.all())
    expect(tries).toBe(FAILURES_IN_A_ROW)
    expect(report.failed.length).toBe(FAILURES_IN_A_ROW)
    expect(report.problems).toEqual([`Stopped after ${FAILURES_IN_A_ROW} failures in a row (the last: 429); 2 logs not tried: download again`])
  })
})
