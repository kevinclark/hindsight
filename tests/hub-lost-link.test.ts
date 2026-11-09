// What a job does when its link to Google Drive is gone (LinkLost, after the adapter's tries): Download, Sync and an add
// from a Drive folder stop at once with words that say where and what to do, keep what is done, and fail no log for it.
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LinkLost, type StorageAdapter } from '../src/hub/adapter.ts'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { ingest, localFolderFiles, type SourceFile } from '../src/hub/ingest.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { fetchLogs, matchesFirst, syncWithTeam } from '../src/hub/sync.ts'
import { robotLog } from './helpers/hub-logs.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0)
let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-lostlink-')) })
afterEach(() => rm(work, { recursive: true, force: true }))

async function logsIn(n: number, name: string): Promise<string> {
  const dir = join(work, `src-${name}`)
  for (let i = 0; i < n; i++) {
    const path = join(dir, `log${i}.wpilog`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, robotLog({ clockMs: CLOCK + i * 3600e3, enabled: [20, 55], event: 'TEST', fms: true, matchType: 2, matchNumber: i + 1, seed: `${name}-${i}` }))
    const t = new Date(CLOCK); await utimes(path, t, t)
  }
  return dir
}
async function libraryWith(n: number, name: string): Promise<LocalLibrary> {
  const lib = await LocalLibrary.open(join(work, name), name)
  await ingest(lib, await localFolderFiles(await logsIn(n, name)), { describe: describeFile })
  return lib
}
const lost = () => new LinkLost('no data from Google Drive for 15 s, at 1.0 of 3.0 MB; tried 3 times')

describe('D6: a lost link to Drive ends the job in words, keeping what is done', () => {
  it('D6: Download stops at the log it was on, keeps the ones before, fails none, and says to download again', async () => {
    const a = await libraryWith(3, 'ma')
    const team = new MemoryAdapter()
    await syncWithTeam(a, team)
    const order = [...a.catalog.all()].sort(matchesFirst)
    const second = order[1]
    const flaky: StorageAdapter = Object.assign(Object.create(team), { read: async (path: string, s: number, e: number) => { if (path === second.path) throw lost(); return team.read(path, s, e) } })
    const b = await LocalLibrary.open(join(work, 'mb'), 'mb')
    const r = await fetchLogs(b, flaky, a.catalog.all())
    expect(r.fetched).toEqual([order[0].path])
    expect(r.failed).toEqual([])
    expect(r.stopped).toBe(false)
    expect(r.notTried).toBe(2)
    expect(r.problems).toEqual([`Stopped at log 2 of 3 (${second.names[0]}): no data from Google Drive for 15 s, at 1.0 of 3.0 MB; tried 3 times. The 1 log that came down is kept. Download again to continue from here.`])
  })

  it('D6: Sync stops at the log it was on, fails none, does not wait out a publish, and says to sync again', async () => {
    const a = await libraryWith(3, 'ma')
    const team = new MemoryAdapter()
    let puts = 0
    const flaky: StorageAdapter = Object.assign(Object.create(team), { writeNew: async (...args: Parameters<StorageAdapter['writeNew']>) => { if (args[0].startsWith('logs/') && ++puts === 2) throw lost(); return team.writeNew(...args) } })
    const r = await syncWithTeam(a, flaky)
    const second = [...a.catalog.all()].sort(matchesFirst)[1]
    expect(r.uploaded.length).toBe(1)
    expect(r.failed).toEqual([])
    expect(r.stopped).toBe(false)
    expect(r.notTried).toBe(2)
    expect(r.problems).toEqual([`Stopped at log 2 of 3 (${second.names[0]}): no data from Google Drive for 15 s, at 1.0 of 3.0 MB; tried 3 times. 1 log went up this sync and will be shared by the next one. Sync again to continue from here.`])
    expect(team.writes.filter((w) => w.includes(a.ownManifestPath))).toEqual([]) // no publish after the link was lost
  })

  it('D6: a link lost before any upload ends the sync in words, as an error (the last record of what is shared stays)', async () => {
    const a = await libraryWith(1, 'ma')
    const team = new MemoryAdapter()
    const dead: StorageAdapter = Object.assign(Object.create(team), { list: async () => { throw lost() } })
    const e = await syncWithTeam(a, dead).catch((x) => x)
    expect(e).toBeInstanceOf(LinkLost)
    expect(e.message).toBe('no data from Google Drive for 15 s, at 1.0 of 3.0 MB; tried 3 times. No log went up; sync again to continue.')
  })

  it('D6: an add from a Drive folder says the folder, and to add it again', async () => {
    const lib = await LocalLibrary.open(join(work, 'mc'), 'mc')
    const files: SourceFile[] = ['x.wpilog', 'y.wpilog'].map((name) => ({ name, where: name, size: 10, modifiedTime: null, from: 'drive', open: async () => { throw lost() } }))
    const r = await ingest(lib, files, { describe: describeFile })
    expect(r.lostLink).toBe("Stopped at file 1 of 2 (x.wpilog): no data from Google Drive for 15 s, at 1.0 of 3.0 MB; tried 3 times. 0 of the folder's 2 logs are in the library (0 added this time). Add the folder again to continue from here.")
    expect(r.unreadable).toEqual([])
  })
})
