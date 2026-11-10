// Download from the team keeps the next range of a log on its way while the one before is hashed and written, so the
// wait before Drive starts sending a range overlaps bytes still arriving: the bar moves without a pause every piece.
process.env.TZ = 'America/Los_Angeles'

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogRecord } from '../src/hub/types.ts'
import { LinkLost, Stopped, bytesSource, type StorageAdapter, type TransferWatch } from '../src/hub/adapter.ts'
import type { ProgressMore } from '../src/hub/jobs.ts'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { fetchLogs } from '../src/hub/sync.ts'
import { readAhead } from '../src/hub/read-ahead.ts'
import { DriveReader, PIECE_READ } from '../src/hub/drive-read.ts'
import { DriveAdapter } from '../src/hub/drive-adapter.ts'
import { FakeDrive } from './helpers/fake-drive.ts'
import { driveFolderFiles } from '../src/hub/drive-source.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0)
const MiB = 1 << 20
const PATH = 'logs/2026-2027/2026-10-17/big.wpilog'
let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-read-ahead-')) })
afterEach(() => rm(work, { recursive: true, force: true }))

const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) & 255)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const record = (bytes: Uint8Array) => ({ type: 'log', path: PATH, size: bytes.length, sha256: sha(bytes), names: ['big.wpilog'], playedAt: CLOCK, recordedAt: CLOCK, machine: 'ma' }) as unknown as LogRecord
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function teamWith(bytes: Uint8Array): Promise<MemoryAdapter> {
  const team = new MemoryAdapter()
  await team.writeNew(PATH, bytesSource(bytes))
  return team
}

/** A team whose reads go through `read`, everything else as `team` does it. */
const withRead = (team: StorageAdapter, read: StorageAdapter['read']): StorageAdapter => Object.assign(Object.create(team), { read })

describe('Download reads one range ahead', () => {
  it('asks for the next range once the one before starts arriving, and never more than two at once', async () => {
    const bytes = pattern(17 * MiB)
    const team = await teamWith(bytes)
    let inFlight = 0
    let most = 0
    const starts: number[] = []
    const arriving = new Set<number>()
    const early: number[] = [] // ranges asked for before the one before them had a byte
    const slow = withRead(team, async (path, start, end, watch) => {
      starts.push(start)
      if (start > 0 && !arriving.has(start - 4 * MiB)) early.push(start)
      most = Math.max(most, ++inFlight)
      try {
        await wait(5); arriving.add(start); watch?.onBytes?.(1) // the first byte arrives, then the rest
        await wait(20); return await team.read(path, start, end)
      } finally { inFlight-- }
    })
    const lib = await LocalLibrary.open(join(work, 'mb'), 'mb')
    const report = await fetchLogs(lib, slow, [record(bytes)])
    expect(report.fetched).toEqual([PATH])
    expect(most).toBe(2)
    expect(starts).toEqual([0, 4, 8, 12, 16].map((n) => n * MiB))
    expect(early).toEqual([])
    expect(sha(new Uint8Array(await lib.store.read(PATH, 0, bytes.length)))).toBe(sha(bytes))
  })

  it('the bar counts the bytes of both ranges as they arrive, never falls back, and ends at the log size', async () => {
    const bytes = pattern(9 * MiB)
    const team = await teamWith(bytes)
    // Each range arrives in two halves, the way a ranged read reports bytes as they come off the connection.
    const halves = withRead(team, async (path, start, end, watch) => {
      await wait(5); watch?.onBytes?.((end - start) >> 1)
      await wait(5); watch?.onBytes?.(end - start)
      return team.read(path, start, end)
    })
    const done: number[] = []
    const lib = await LocalLibrary.open(join(work, 'mb'), 'mb')
    await fetchLogs(lib, halves, [record(bytes)], { onProgress: (_d, _t, _c, more?: ProgressMore) => { if (more?.file) done.push(more.file.done) } })
    expect(done.at(-1)).toBe(bytes.length)
    expect(done).toEqual([...done].sort((a, b) => a - b))
    expect(done.some((n) => n % (4 * MiB) !== 0)).toBe(true) // bytes count as they arrive, not only per piece
  })

  it('a range read ahead that nothing took is told to stop once the log fails, and its bytes and words no longer reach the bar', async () => {
    const bytes = pattern(13 * MiB)
    const team = await teamWith(bytes)
    let held: TransferWatch | undefined
    const flaky = withRead(team, async (path, start, end, watch) => {
      if (start === 4 * MiB) { watch?.onBytes?.(1); await wait(5); throw new LinkLost('no data from Google Drive for 15 s') }
      if (start === 8 * MiB) { held = watch; return new Promise<Uint8Array>(() => {}) } // never answers
      return team.read(path, start, end)
    })
    let events = 0
    const lib = await LocalLibrary.open(join(work, 'mb'), 'mb')
    const report = await fetchLogs(lib, flaky, [record(bytes)], { onProgress: () => { events++ } })
    expect(report.fetched).toEqual([])
    expect(report.problems.length).toBe(1)
    expect(held?.cancelled?.()).toBe(true)
    const before = events
    held?.onBytes?.(MiB)
    held?.onStep?.('Google Drive stopped sending; trying again (try 2 of 3)')
    expect(events).toBe(before)
    expect(await readdir(join(lib.root, 'logs/2026-2027/2026-10-17'))).toEqual([])
  })
})

describe('readAhead on its own', () => {
  it('a range that reports fewer bytes than before (a retry from its next byte) never takes the total back', async () => {
    const totals: number[] = []
    let watch: TransferWatch | undefined
    const source = readAhead(100, async (_s, e, w) => { watch = w; w.onBytes?.(60); w.onBytes?.(40); return new Uint8Array(e) }, { onBytes: (n) => totals.push(n) })
    await source.read(0, 100)
    expect(totals).toEqual([60, 100])
    expect(watch).toBeDefined()
  })

  it('after Stop, bytes still arriving on a range no longer move the total', async () => {
    let stop = false
    const totals: number[] = []
    const source = readAhead(100, async (_s, e, w) => { w.onBytes?.(30); stop = true; w.onBytes?.(60); return new Uint8Array(e) }, { cancelled: () => stop, onBytes: (n) => totals.push(n) })
    await source.read(0, 100)
    expect(totals).toEqual([30])
  })

  it('a range read ahead that fails before it is taken is asked again when taken: its words stay off the bar, nothing counts twice', async () => {
    const tries: number[] = []
    const steps: string[] = []
    const totals: number[] = []
    const source = readAhead(200, async (s, e, w) => {
      tries.push(s)
      if (s === 0) { w.onBytes?.(1); await wait(30); return new Uint8Array(e - s) }
      if (tries.filter((t) => t === s).length === 1) { w.onBytes?.(10); w.onStep?.('Google Drive stopped sending; trying again'); throw new LinkLost('starved') }
      w.onBytes?.(5); w.onBytes?.(e - s); return new Uint8Array(e - s)
    }, { onBytes: (n) => totals.push(n), onStep: (words) => steps.push(words) })
    await source.read(0, 100)
    await wait(5)
    expect((await source.read(100, 200)).length).toBe(100)
    expect(tries).toEqual([0, 100, 100])
    expect(steps).toEqual([])
    expect(totals).toEqual([...totals].sort((a, b) => a - b))
    expect(totals.at(-1)).toBe(200)
  })

  it('a range the reader is waiting on that fails fails the read', async () => {
    const source = readAhead(100, async () => { throw new LinkLost('gone') })
    await expect(source.read(0, 100)).rejects.toThrow(/gone/)
  })

  it('refuses a read out of order or of another size, rather than leave a range in flight that nothing will take', async () => {
    const source = readAhead(300, async (s, e) => new Uint8Array(e - s))
    await source.read(0, 100)
    expect(() => source.read(200, 300)).toThrow(/front to back/)
    expect(() => source.read(100, 150)).toThrow(/front to back/)
  })
})

describe('Adding from a Drive folder and the phone opening a log read one range ahead too', () => {
  /** A Drive whose media answers wait, send one byte, wait, then the rest: counts ranges in flight and any asked early. */
  function slowDrive(content: Uint8Array) {
    const drive = new FakeDrive()
    const folder = drive.addFolder('root', 'logs')
    const id = drive.addFile(folder, 'big.wpilog', content)
    let inFlight = 0
    const seen = { most: 0, ranges: [] as number[], early: [] as number[] }
    const arriving = new Set<number>()
    const f: typeof fetch = async (url, init) => {
      const range = new Headers(init?.headers as Record<string, string>).get('range')
      if (!range) return drive.fetch(url, init)
      const start = Number(/bytes=(\d+)-/.exec(range)![1])
      seen.ranges.push(start)
      if (start > 0 && !arriving.has(start - PIECE_READ)) seen.early.push(start)
      seen.most = Math.max(seen.most, ++inFlight)
      const body = new Uint8Array(await (await drive.fetch(url, init)).arrayBuffer())
      await wait(5)
      let sent = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          if (sent === 0) { arriving.add(start); c.enqueue(body.slice(0, 1)); sent = 1; return }
          await wait(20)
          c.enqueue(body.slice(1)); c.close(); inFlight--
        },
      }), { status: 206, headers: { 'content-range': `bytes ${start}-${start + body.length - 1}/${content.length}` } })
    }
    return { id, f, seen }
  }
  const content = pattern(2 * PIECE_READ + 12345)

  it('the phone: the next slice is asked for once the one before starts arriving, two at most, the file whole', async () => {
    const { f, seen } = slowDrive(content)
    const reader = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async () => {} })
    const progress: number[] = []
    const got = await reader.downloadWhole('logs/big.wpilog', { onProgress: (n) => progress.push(n) })
    expect(sha(got)).toBe(sha(content))
    expect([seen.most, seen.ranges, seen.early]).toEqual([2, [0, PIECE_READ, 2 * PIECE_READ], []])
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(progress.at(-1)).toBe(content.length)
  })

  it('a Drive folder: the next range is asked for once the one before starts arriving, two at most, written in order', async () => {
    const { id, f, seen } = slowDrive(content)
    const drive = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async () => {} })
    const parts: Uint8Array[] = []
    const progress: number[] = []
    await drive.download(id, content.length, async (chunk) => { parts.push(chunk) }, { onBytes: (n) => progress.push(n) })
    const whole = new Uint8Array(content.length)
    let at = 0
    for (const p of parts) { whole.set(p, at); at += p.length }
    expect([at, sha(whole)]).toEqual([content.length, sha(content)])
    expect([seen.most, seen.ranges, seen.early]).toEqual([2, [0, PIECE_READ, 2 * PIECE_READ], []])
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(progress.at(-1)).toBe(content.length)
  })
})

describe('Stop and failure stop the range read ahead (Drive folder, phone)', () => {
  const content = pattern(2 * PIECE_READ + 12345)
  /** One byte, then the rest after `restMs`; records each media request's abort signal. */
  function drive(restMs: number) {
    const fake = new FakeDrive()
    const folder = fake.addFolder('root', 'logs')
    const id = fake.addFile(folder, 'big.wpilog', content)
    const signals: AbortSignal[] = []
    const f: typeof fetch = async (url, init) => {
      const range = new Headers(init?.headers as Record<string, string>).get('range')
      if (!range) return fake.fetch(url, init)
      if (init?.signal) signals.push(init.signal)
      const start = Number(/bytes=(\d+)-/.exec(range)![1])
      const body = new Uint8Array(await (await fake.fetch(url, init)).arrayBuffer())
      let sent = 0
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          if (sent === 0) { c.enqueue(body.slice(0, 1)); sent = 1; return }
          await wait(restMs)
          c.enqueue(body.slice(1)); c.close()
        },
      }), { status: 206, headers: { 'content-range': `bytes ${start}-${start + body.length - 1}/${content.length}` } })
    }
    return { id, f, signals }
  }

  it('the phone: Stop with the next slice in flight rejects Stopped and aborts both requests', async () => {
    const { f, signals } = drive(5000)
    const reader = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async () => {} })
    const stop = new AbortController()
    const got = reader.downloadWhole('logs/big.wpilog', { signal: stop.signal })
    while (signals.length < 2) await wait(5)
    stop.abort()
    await expect(got).rejects.toThrow(Stopped)
    await wait(400)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
  })

  it('the phone: a slice that fails for good stops the slice read ahead', async () => {
    const fake = new FakeDrive()
    fake.addFile(fake.addFolder('root', 'logs'), 'big.wpilog', content)
    const signals: AbortSignal[] = []
    const f: typeof fetch = async (url, init) => {
      const range = new Headers(init?.headers as Record<string, string>).get('range')
      if (!range) return fake.fetch(url, init)
      const start = Number(/bytes=(\d+)-/.exec(range)![1])
      if (start === 1) return new Response('gone', { status: 404 }) // slice 0 asked again from its next byte: refused
      if (init?.signal) signals.push(init.signal)
      let sent = false
      return new Response(new ReadableStream<Uint8Array>({
        async pull(c) {
          if (!sent) { sent = true; c.enqueue(new Uint8Array(1)); return }
          if (start === 0) { await wait(20); c.error(new Error('connection reset')); return }
          await wait(5000)
        },
      }), { status: 206, headers: { 'content-range': `bytes ${start}-${start + PIECE_READ - 1}/${content.length}` } })
    }
    const reader = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async () => {} })
    await expect(reader.downloadWhole('logs/big.wpilog')).rejects.toThrow(/404/)
    await wait(400)
    expect(signals.length).toBe(2)
    expect(signals[1].aborted).toBe(true)
  })

  it('a Drive folder: a sink that fails stops the range read ahead', async () => {
    const { id, f, signals } = drive(50)
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async () => {} })
    await expect(store.download(id, content.length, async () => { throw new Error('disk full') })).rejects.toThrow(/disk full/)
    await wait(400)
    expect(signals.length).toBe(2)
    expect(signals[1].aborted).toBe(true)
  })

  it('a Drive folder: Stop part way leaves no temp file and stops both requests', async () => {
    const { f, signals } = drive(5000)
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: f, sleep: async () => {} })
    const temp = join(work, 'temp')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(temp)
    const [file] = (await driveFolderFiles(store, 'root', temp)).filter((x) => x.name === 'big.wpilog')
    let stop = false
    const opened = file.open({ cancelled: () => stop })
    while (signals.length < 2) await wait(5)
    stop = true
    await expect(opened).rejects.toThrow(Stopped)
    await wait(400)
    expect(signals.map((s) => s.aborted)).toEqual([true, true])
    expect(await readdir(temp)).toEqual([])
  })
})
