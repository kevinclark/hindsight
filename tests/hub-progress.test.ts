// Progress you can read and a Stop that answers: the job runner's events, byte counts through sync, download and ingest,
// and Stop part way through a file (Drive, the local folder, the robot) leaving nothing behind and failing nothing.
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BYTES_EVERY_MS, JobRunner, fileMeter, type JobProgress, type ProgressMore } from '../src/hub/jobs.ts'
import { SETTLE_MS, estimateLeft } from '../src/ui/job-bar.ts'
import type { LogRecord } from '../src/hub/types.ts'
import { Stopped, bytesSource } from '../src/hub/adapter.ts'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalFolderAdapter } from '../src/hub/local-adapter.ts'
import { DriveAdapter } from '../src/hub/drive-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { ingest, localFolderFiles } from '../src/hub/ingest.ts'
import { fetchLogs, syncWithTeam } from '../src/hub/sync.ts'
import { robotFiles, type RobotEntry, type RobotFs } from '../src/hub/robot.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { parseManifest } from '../src/hub/types.ts'
import { readText } from '../src/hub/adapter.ts'
import { robotLog } from './helpers/hub-logs.ts'
import { FakeDrive } from './helpers/fake-drive.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0)
const MiB = 1 << 20
let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-progress-')) })
afterEach(() => rm(work, { recursive: true, force: true }))

const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
/** Turns true after `after` asks: a Stop pressed part way through. */
const stopAfter = (after: number) => { let asked = 0; return () => ++asked > after }

async function libraryWith(n: number, name = 'ma'): Promise<LocalLibrary> {
  const lib = await LocalLibrary.open(join(work, name), name)
  const dir = join(work, `src-${name}`)
  for (let i = 0; i < n; i++) {
    const path = join(dir, `log${i}.wpilog`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, robotLog({ clockMs: CLOCK + i * 3600e3, enabled: [20, 55], event: 'TEST', fms: true, matchType: 2, matchNumber: i + 1, seed: `${name}-${i}` }))
    const t = new Date(CLOCK); await utimes(path, t, t)
  }
  await ingest(lib, await localFolderFiles(dir), { describe: describeFile })
  return lib
}

type Event = { done: number; total: number; current: string; more?: ProgressMore }
const recorder = () => { const events: Event[] = []; return { events, onProgress: (done: number, total: number, current: string, more?: ProgressMore) => { events.push({ done, total, current, more }) } } }

describe('the job runner tells the page', () => {
  it('that Stop was pressed, at once, before the job reaches its next piece; and every later event says so', async () => {
    const runner = new JobRunner()
    const sent: (JobProgress | null)[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const job = runner.run('Syncing', async (_j, progress) => { progress(2, 9, 'a.wpilog'); await gate; progress(3, 9, 'b.wpilog') }, (p) => sent.push(p))
    runner.cancel()
    expect(sent.at(-1)).toEqual({ job: 'Syncing', done: 2, total: 9, current: 'a.wpilog', stopping: true })
    expect(runner.current()?.stopping).toBe(true)
    runner.cancel() // a second press sends nothing more
    expect(sent.length).toBe(2)
    release(); await job
    expect(sent.slice(2)).toEqual([{ job: 'Syncing', done: 3, total: 9, current: 'b.wpilog', stopping: true }, null])
  })
  it('a Stop pressed before the first event shows on the job by name', async () => {
    const runner = new JobRunner()
    let seen: JobProgress | null = null
    await runner.run('Pulling logs off the robot', async () => { runner.cancel(); seen = runner.current() })
    expect(seen).toEqual({ job: 'Pulling logs off the robot', done: 0, total: 0, current: '', stopping: true })
  })
  it(`a new file, count or step at once, and a byte count alone at most every ${BYTES_EVERY_MS} ms`, async () => {
    let t = 0
    const runner = new JobRunner(() => t)
    const sent: (JobProgress | null)[] = []
    await runner.run('Syncing', async (_j, progress) => {
      progress(0, 0, '', { step: 'Listing' })
      progress(0, 0, '', { step: 'Sharing' }) // a new step: sent
      progress(0, 2, 'a', { bytes: { done: 0, total: 10 }, file: { done: 0, total: 5 } }) // a new count: sent
      t += 10; progress(0, 2, 'a', { bytes: { done: 1, total: 10 }, file: { done: 1, total: 5 } }) // bytes only, 10 ms on: held
      t += BYTES_EVERY_MS; progress(0, 2, 'a', { bytes: { done: 2, total: 10 }, file: { done: 2, total: 5 } }) // bytes only, past the gap: sent
      t += 1; progress(1, 2, 'b', { bytes: { done: 5, total: 10 }, file: { done: 0, total: 5 } }) // a new file: sent at once
    }, (p) => sent.push(p))
    expect(sent.map((p) => (p ? p.step ?? `${p.current}:${p.bytes?.done}` : null))).toEqual(['Listing', 'Sharing', 'a:0', 'a:2', 'b:5', null])
  })
})

describe('Stop part way through a file leaves nothing at its path', () => {
  it('the local folder: no file and no temp file', async () => {
    const store = new LocalFolderAdapter(join(work, 'store'))
    const bytes = pattern(9 * MiB) // three 4 MiB pieces
    await expect(store.writeNew('logs/y/a.wpilog', bytesSource(bytes), { cancelled: stopAfter(1) })).rejects.toBeInstanceOf(Stopped)
    expect(await store.stat('logs/y/a.wpilog')).toBeNull()
    expect(await readdir(join(work, 'store/logs/y'))).toEqual([])
  })
  it('Drive: the upload is left unfinished, so Drive keeps no file', async () => {
    const drive = new FakeDrive()
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: drive.fetch, sleep: async () => {} })
    const bytes = pattern(17 * MiB) // three 8 MiB pieces
    const sent: number[] = []
    let stop = false // pressed once the first 8 MiB piece is handed over
    await expect(store.writeNew('logs/y/a.wpilog', bytesSource(bytes), { sha256: sha(bytes), cancelled: () => stop, onProgress: (n) => { sent.push(n); if (n >= 8 * MiB) stop = true } })).rejects.toBeInstanceOf(Stopped)
    expect(Math.max(...sent)).toBe(8 * MiB) // the first piece went (counted as the connection took it), the second was never sent
    expect(sent.length).toBeGreaterThan(1)
    expect(drive.at('logs/y/a.wpilog')).toBeFalsy()
  })
})

describe('sync', () => {
  it('counts bytes over the whole job and the current log, and names its steps before the logs', async () => {
    const lib = await libraryWith(3)
    const sizes = lib.catalog.all().map((r) => r.size)
    const total = sizes.reduce((a, b) => a + b, 0)
    const { events, onProgress } = recorder()
    const report = await syncWithTeam(lib, new MemoryAdapter(), { onProgress })
    expect(report.uploaded.length).toBe(3)
    const steps = events.filter((e) => e.more?.step).map((e) => e.more!.step!)
    expect(steps[0]).toBe("Looking for teammates' lists of logs")
    expect(steps.at(-1)).toBe('Telling the team which logs are up')
    const logs = events.filter((e) => e.more?.bytes)
    expect(new Set(logs.map((e) => e.more!.bytes!.total))).toEqual(new Set([total]))
    const done = logs.map((e) => e.more!.bytes!.done)
    expect(done).toEqual([...done].sort((a, b) => a - b)) // never goes back
    expect(done.at(-1)).toBe(total) // the last log's last piece
    // While a log is going up, the count is the logs finished before it.
    expect(logs.filter((e) => e.more!.file!.done > 0).map((e) => e.done)).toEqual([0, 1, 2])
  })
  it('Stop part way through a log: nothing of it on the team store, no failure, the rest left for next time, and what went up is published', async () => {
    const lib = await libraryWith(3)
    const team = new MemoryAdapter()
    let stop = false
    let writes = 0
    const write = team.writeNew.bind(team)
    team.writeNew = (path, from, o) => { if (path.startsWith('logs/') && ++writes === 2) stop = true; return write(path, from, o) } // pressed as the second log starts
    const report = await syncWithTeam(lib, team, { cancelled: () => stop })
    expect(report.stopped).toBe(true)
    expect(report.uploaded.length).toBe(1)
    expect(report.failed).toEqual([])
    expect(report.notTried).toBe(2)
    expect((await team.list('logs')).length).toBe(1)
    expect(parseManifest((await readText(team, 'manifests/ma.jsonl'))!).records.filter((r) => r.type === 'log').length).toBe(1)
    const again = await syncWithTeam(lib, team)
    expect([again.uploaded.length, again.stopped, again.notTried]).toEqual([2, false, 0])
  })
})

describe('download from the team', () => {
  it('counts bytes, and Stop part way through a log leaves no file or temp file and fails nothing', async () => {
    const team = new MemoryAdapter()
    await syncWithTeam(await libraryWith(2), team)
    const b = await LocalLibrary.open(join(work, 'mb'), 'mb')
    await syncWithTeam(b, team)
    const { events, onProgress } = recorder()
    const all = await fetchLogs(b, team, b.catalog.all(), { onProgress })
    expect(all.fetched.length).toBe(2)
    expect(events.at(-1)!.more!.bytes).toEqual({ done: b.catalog.all().reduce((n, r) => n + r.size, 0), total: b.catalog.all().reduce((n, r) => n + r.size, 0) })

    const c = await LocalLibrary.open(join(work, 'mc'), 'mc')
    await syncWithTeam(c, team)
    const stopped = await fetchLogs(c, team, c.catalog.all(), { cancelled: stopAfter(1) }) // the first log's check passes; its first piece's does not
    expect([stopped.stopped, stopped.fetched.length, stopped.failed.length, stopped.notTried]).toEqual([true, 0, 0, 2])
    const left = (await readdir(join(c.root), { recursive: true })).filter((n) => n.endsWith('.wpilog') || n.endsWith('.part'))
    expect(left).toEqual([])
  })
})

describe('pulling off the robot', () => {
  const NOW = Date.UTC(2026, 9, 17, 20)
  const entry = (name: string, size: number): RobotEntry => ({ name, size, mtimeMs: NOW - 3600e3, isDir: false })
  /** A robot that sends each file in 100-byte pieces, reporting each and stopping when asked, as the SFTP download does. */
  function robot(files: Record<string, Uint8Array>): RobotFs & { stoppedAt: Record<string, number> } {
    const fs = {
      stoppedAt: {} as Record<string, number>,
      async list(dir: string) { return dir === '/home/lvuser/logs' ? Object.entries(files).map(([n, b]) => entry(n, b.length)) : [] },
      async download(remote: string, local: string, watch: Parameters<RobotFs['download']>[2] = {}) {
        const bytes = files[remote.split('/').pop()!]
        for (let at = 0; at < bytes.length; at += 100) {
          if (watch.cancelled?.()) { fs.stoppedAt[remote] = at; throw new Stopped() }
          await writeFile(local, bytes.subarray(0, Math.min(bytes.length, at + 100)))
          watch.onProgress?.(Math.min(bytes.length, at + 100), 0)
        }
      },
      close() {},
    }
    return fs
  }
  const logBytes = (seed: string) => robotLog({ clockMs: CLOCK, enabled: [20, 55], seed })

  it('reports the download bytes against the size the robot listed', async () => {
    const lib = await LocalLibrary.open(join(work, 'lib'), 'ma')
    const a = logBytes('r-a')
    const { files } = await robotFiles(robot({ 'a.wpilog': a }), { now: () => NOW, sleep: async () => {}, tempRoot: work })
    const { events, onProgress } = recorder()
    const report = await ingest(lib, files, { describe: describeFile, onProgress })
    expect(report.added.length).toBe(1)
    const pieces = events.filter((e) => e.more!.file!.done > 0)
    expect(pieces.every((e) => e.more!.file!.total === a.length && e.more!.bytes!.total === a.length)).toBe(true)
    expect(pieces.at(-1)!.more!.file!.done).toBe(a.length)
    // The copy into the library does not run the bar again from zero.
    expect(pieces.map((e) => e.more!.file!.done)).toEqual([...pieces.map((e) => e.more!.file!.done)].sort((x, y) => x - y))
  })
  it('Stop part way through a download: not filed, not unreadable, not remembered as seen, and the rest left for next time', async () => {
    const lib = await LocalLibrary.open(join(work, 'lib'), 'ma')
    const fs = robot({ 'a.wpilog': logBytes('r-a'), 'b.wpilog': logBytes('r-b') })
    const { files } = await robotFiles(fs, { now: () => NOW, sleep: async () => {}, tempRoot: work })
    const seen = new Map<string, string>()
    let stop = false
    const report = await ingest(lib, files, { describe: describeFile, seen, cancelled: () => stop, onProgress: (_d, _t, _c, more) => { if ((more?.file?.done ?? 0) >= 200) stop = true } })
    expect(fs.stoppedAt['/home/lvuser/logs/a.wpilog']).toBe(200)
    expect([report.stopped, report.added.length, report.unreadable.length, report.notTried]).toEqual([true, 0, 0, 2])
    expect(seen.size).toBe(0)
    expect((await readdir(work)).filter((n) => n.startsWith('hindsight-robot-'))).toEqual([]) // its temp folder is gone
  })
})

describe('the byte count', () => {
  it('drops a file skipped without a transfer from the total instead of jumping the count, so the rate is of real transfer', () => {
    const { events, onProgress } = recorder()
    const meter = fileMeter(onProgress, [100, 900, 50])
    const a = meter.start(0, 3, 'a', 100); a.at(100); a.end()
    const b = meter.start(1, 3, 'b', 900); b.end() // already there: no bytes moved
    const c = meter.start(2, 3, 'c', 50); c.at(25)
    expect(events.at(-1)!.more!.bytes).toEqual({ done: 125, total: 150 })
    expect(events.map((e) => e.more!.bytes!.done)).toEqual([0, 100, 100, 100, 125])
  })
})

describe('time left', () => {
  const at = (s: number, bytes: number) => ({ at: s * 1000, bytes })
  it('says nothing before the rate settles, or when nothing moves', () => {
    expect(estimateLeft([at(0, 0), at(SETTLE_MS / 1000 - 1, 1e6)], 1e9)).toBe('')
    expect(estimateLeft([at(0, 5e6), at(10, 5e6)], 1e9)).toBe('')
  })
  it('uses the last 30 s of rate: a link that slowed down is not judged by its fast start', () => {
    // 1 MB/s for 60 s, then 0.1 MB/s for 30 s; 100 MB left at 0.1 MB/s is ~17 min, not ~2 min.
    const samples = [at(0, 0), at(60, 60e6), at(90, 63e6)]
    expect(estimateLeft(samples, 163e6)).toBe('about 17 min left')
    expect(estimateLeft([at(0, 0), at(10, 10e6)], 50e6)).toBe('under a minute left')
    expect(estimateLeft([at(0, 0), at(10, 1e6)], 1e9)).toBe('about 2.8 h left')
  })
})

describe('Stop between pieces of a download from the team', () => {
  it('a 9 MiB log stopped after its first 4 MiB piece leaves no file and no temp file', async () => {
    const team = new MemoryAdapter()
    const bytes = pattern(9 * MiB)
    await team.writeNew('logs/2026-2027/2026-10-17/big.wpilog', bytesSource(bytes))
    const lib = await LocalLibrary.open(join(work, 'mb'), 'mb')
    const r = { type: 'log', path: 'logs/2026-2027/2026-10-17/big.wpilog', size: bytes.length, sha256: sha(bytes), names: ['big.wpilog'], playedAt: CLOCK, recordedAt: CLOCK, machine: 'ma' } as unknown as LogRecord
    const pieces: number[] = []
    let stop = false
    const report = await fetchLogs(lib, team, [r], { cancelled: () => stop, onProgress: (_d, _t, _c, more) => { const n = more?.file?.done ?? 0; if (n > 0) { pieces.push(n); stop = true } } })
    expect(pieces[0]).toBe(4 * MiB) // the range read ahead may land too: its bytes did arrive, but are never written
    expect([report.stopped, report.fetched.length, report.failed.length]).toEqual([true, 0, 0])
    expect(await readdir(join(lib.root, 'logs/2026-2027/2026-10-17'))).toEqual([])
  })
})

describe('Stop during the copy into the library', () => {
  it('is not remembered as seen, so the next pull reads the file again', async () => {
    const lib = await LocalLibrary.open(join(work, 'lib'), 'ma')
    const dir = join(work, 'src')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.wpilog'), robotLog({ clockMs: CLOCK, enabled: [20, 55], seed: 'copy-stop' }))
    const seen = new Map<string, string>()
    let asks = 0
    const report = await ingest(lib, await localFolderFiles(dir), { describe: describeFile, seen, cancelled: () => ++asks > 1 }) // the file's own check passes; the copy's first piece stops
    expect([report.stopped, report.added.length]).toEqual([true, 0])
    expect(seen.size).toBe(0)
    const again = await ingest(lib, await localFolderFiles(dir), { describe: describeFile, seen })
    expect(again.added.length).toBe(1)
    expect(seen.size).toBe(1)
  })
})
