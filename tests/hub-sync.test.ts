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
import { fetchLogs, syncWithTeam } from '../src/hub/sync.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { readText } from '../src/hub/adapter.ts'
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
    const report = await syncWithTeam(a, team)
    expect(report.uploaded.map((u) => u.how)).toEqual(['upload', 'upload'])
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

    const synced = await syncWithTeam(a, team)
    expect(synced.uploaded.map((u) => u.how)).toEqual(['copy inside Drive', 'copy inside Drive'])
    expect(team.calls.copy).toBe(2)
    expect(team.calls.upload).toBe(1) // the manifest only
    expect(drive.at('team-folder/logs/2026-2027/2026-10-17/one.wpilog')?.bytes?.length).toBe(logA.length)
    expect(drive.at('old logs/practice/one.wpilog')).toBeDefined() // the originals stay
    expect((await stat(a.store.at(a.catalog.all()[0].path))).size).toBeGreaterThan(0)
  })

  it('falls back to uploading when the copy inside Drive is refused', async () => {
    const drive = new FakeDrive()
    const teamFolder = drive.addFolder('root', 'team-folder')
    const old = drive.addFolder('root', 'old logs')
    drive.addFile(old, 'one.wpilog', robotLog({ clockMs: CLOCK, enabled: [20, 55], seed: 'x' }))
    const mk = (root: string) => new DriveAdapter({ rootId: root, token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const a = await machine('ma')
    await ingest(a, await driveFolderFiles(mk(old), old, work), options)
    // Make every record's source id unusable (the file was moved to a drive this user can't copy from).
    const team = mk(teamFolder)
    team.copyInto = async () => { throw new Error('403') }
    const synced = await syncWithTeam(a, team)
    expect(synced.uploaded.map((u) => u.how)).toEqual(['upload'])
  })
})
