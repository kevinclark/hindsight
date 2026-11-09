// Google Drive transfers that never stall silently: a real HTTP server on 127.0.0.1 that goes quiet or drops mid-body, and
// the Drive adapter noticing, asking again from the next byte (a read) or from the byte Drive kept (an upload), or stopping
// in words. Invented bytes only.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkLost, Stopped, bytesSource } from '../src/hub/adapter.ts'
import { DriveAdapter } from '../src/hub/drive-adapter.ts'
import { DriveReader } from '../src/hub/drive-read.ts'
import { STALL_MS, Stalled, TRIES, watchdog } from '../src/hub/transfer-watch.ts'
import { startHttpDrive, type HttpDrive, type HttpDriveOptions } from './helpers/http-drive-server.ts'

vi.setConfig({ testTimeout: 30_000 })

const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const STALL = 300
const MiB = 1 << 20
/** Bytes that tell any misplaced byte: each 4-byte word is its own offset. */
const bytesOf = (n: number) => { const b = Buffer.alloc(n); for (let i = 0; i + 4 <= n; i += 4) b.writeUInt32LE(i / 4, i); return new Uint8Array(b) }
const FILE = bytesOf(3 * MiB)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const serve = async (o: Partial<HttpDriveOptions> = {}): Promise<HttpDrive> => { const s = await startHttpDrive({ file: FILE, ...o }); cleanups.push(() => s.close()); return s }
const adapter = (s: HttpDrive) => new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: s.fetch, sleep: async () => {}, stallMs: STALL })
const watched = () => {
  const steps: string[] = []
  const lines: string[] = []
  const bytes: number[] = []
  return { steps, lines, bytes, watch: { onStep: (w: string) => steps.push(w), log: (l: string) => lines.push(l), onBytes: (n: number) => bytes.push(n) } }
}

describe('D0: one watchdog for every transfer', () => {
  it('D0: names the defaults the robot pull uses too: 15 s, 3 tries', () => {
    expect([STALL_MS, TRIES]).toEqual([15_000, 3])
  })
  it('D0: fires the stall once nothing moved for the stall time, and not while something moves', async () => {
    let stalled = 0
    const dog = watchdog({ stallMs: 200, onStall: () => stalled++, onStop: () => {} })
    for (let i = 0; i < 6; i++) { await sleep(60); dog.alive() } // 360 ms, alive every 60 ms
    expect(stalled).toBe(0)
    await sleep(320)
    expect(stalled).toBe(1)
    dog.alive(); await sleep(300)
    expect(stalled).toBe(1) // once only
  })
  it('D0: a grace moves the stall later (a wait whose bytes cannot be seen)', async () => {
    let stalled = 0
    const dog = watchdog({ stallMs: 100, onStall: () => stalled++, onStop: () => {} })
    dog.alive(300)
    await sleep(250)
    expect(stalled).toBe(0)
    await sleep(250)
    expect(stalled).toBe(1)
  })
  it('D0: Stop fires within a tick while nothing moves', async () => {
    let stop = false
    let stopped = 0
    watchdog({ stallMs: 10_000, cancelled: () => stop, onStall: () => {}, onStop: () => stopped++ })
    stop = true
    await sleep(300)
    expect(stopped).toBe(1)
  })
})

describe('D1: a ranged read that goes quiet mid-body asks again from the next byte', () => {
  it('D1: detected at the stall time; the retry asks from where the bytes stopped; the bytes are exact', async () => {
    const s = await serve({ onRead: (r) => (r.n === 0 ? { do: 'hold', after: MiB } : { do: 'serve' }) })
    const w = watched()
    const t = Date.now()
    const got = await adapter(s).read('logs/a.wpilog', 0, FILE.length, w.watch)
    expect(Date.now() - t).toBeGreaterThanOrEqual(STALL)
    expect(sha(got)).toBe(sha(FILE))
    expect(s.log.filter((l) => l.startsWith('GET'))).toEqual([`GET bytes=0-${FILE.length - 1}`, `GET bytes=${MiB}-${FILE.length - 1}`])
    expect(w.steps).toEqual(['Google Drive stopped sending; trying again (try 2 of 3)'])
    expect(w.lines[0]).toMatch(/^stall \(try 1 of 3\): no data from Google Drive for 0\.3 s, at 1\.0 of 3\.0 MB$/)
    // Bytes counted as they arrived, never back to 0 across the retry, ending at the file's size.
    expect(w.bytes.length).toBeGreaterThan(2)
    expect(w.bytes.every((n, i) => i === 0 || n >= w.bytes[i - 1])).toBe(true)
    expect(w.bytes.at(-1)).toBe(FILE.length)
  })
  it('D1: a request that never answers (no headers) is a stall too, and asked again', async () => {
    const s = await serve({ onRead: (r) => (r.n === 0 ? { do: 'silent' } : { do: 'serve' }) })
    const w = watched()
    expect(sha(await adapter(s).read('logs/a.wpilog', 0, FILE.length, w.watch))).toBe(sha(FILE))
    expect(w.lines[0]).toMatch(/no answer from Google Drive for 0\.3 s, at 0\.0 of 3\.0 MB/)
  })
})

describe('D2: a dropped connection mid-body resumes from the next byte', () => {
  it('D2: the retry asks from where the bytes stopped; the bytes are exact', async () => {
    const s = await serve({ onRead: (r) => (r.n === 0 ? { do: 'drop', after: 2 * MiB } : { do: 'serve' }) })
    const w = watched()
    expect(sha(await adapter(s).read('logs/a.wpilog', 0, FILE.length, w.watch))).toBe(sha(FILE))
    expect(s.log.filter((l) => l.startsWith('GET'))[1]).toBe(`GET bytes=${2 * MiB}-${FILE.length - 1}`)
    expect(w.steps[0]).toBe('Lost the connection to Google Drive; trying again (try 2 of 5)')
  })
})

describe('D3: a link that never comes back stops the transfer in words', () => {
  it('D3: after 3 stalls with nothing moving, LinkLost says how long, where, and how many tries', async () => {
    const s = await serve({ onRead: (r) => (r.n === 0 ? { do: 'hold', after: MiB } : { do: 'silent' }) })
    const e = await adapter(s).read('logs/a.wpilog', 0, FILE.length).catch((x) => x)
    expect(e).toBeInstanceOf(LinkLost)
    expect(e.reason).toBe('no answer from Google Drive for 0.3 s, at 1.0 of 3.0 MB; tried 3 times')
  })
  it('D3: a stall that moved bytes starts the count again (a slow, flaky link still finishes)', async () => {
    // Four stalls, each after another 512 KiB: more than TRIES, but every try moved bytes.
    const s = await serve({ onRead: (r) => (r.n < 4 ? { do: 'hold', after: MiB / 2 } : { do: 'serve' }) })
    expect(sha(await adapter(s).read('logs/a.wpilog', 0, FILE.length))).toBe(sha(FILE))
    expect(s.log.filter((l) => l.startsWith('GET')).length).toBe(5)
  })
  it('D3: the phone reader (DriveReader alone) is watched the same way', async () => {
    const s = await serve({ onRead: () => ({ do: 'silent' }) })
    const reader = new DriveReader({ rootId: 'root', token: async () => 'good', fetch: s.fetch, sleep: async () => {}, stallMs: STALL })
    await expect(reader.read('logs/a.wpilog', 0, 10)).rejects.toBeInstanceOf(LinkLost)
  })
})

describe('D4: Stop answers at every point', () => {
  it('D4: Stop during a held read resolves promptly with Stopped', async () => {
    const s = await serve({ onRead: () => ({ do: 'hold', after: MiB }) })
    let stop = false
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: s.fetch, sleep: async () => {}, stallMs: 10_000 })
    const p = store.read('logs/a.wpilog', 0, FILE.length, { cancelled: () => stop })
    await sleep(300)
    const t = Date.now()
    stop = true
    await expect(p).rejects.toBeInstanceOf(Stopped)
    expect(Date.now() - t).toBeLessThan(1000)
  })
  it('D4: Stop during a held upload resolves promptly with Stopped, and leaves no file', async () => {
    const s = await serve({ onPut: () => ({ do: 'hold', after: MiB }) })
    let stop = false
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: s.fetch, sleep: async () => {}, stallMs: 10_000 })
    const p = store.writeNew('logs/up.wpilog', bytesSource(FILE), { cancelled: () => stop })
    await sleep(500)
    const t = Date.now()
    stop = true
    await expect(p).rejects.toBeInstanceOf(Stopped)
    expect(Date.now() - t).toBeLessThan(1000)
    expect(s.uploaded).toBeNull()
  })
  it('D4: Stop while waiting out a stall before the retry stops before asking again', async () => {
    const s = await serve({ onRead: () => ({ do: 'silent' }) })
    let stop = false
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: s.fetch, sleep: async () => { stop = true }, stallMs: STALL })
    await expect(store.read('logs/a.wpilog', 0, 10, { cancelled: () => stop })).rejects.toBeInstanceOf(Stopped)
    expect(s.log.filter((l) => l.startsWith('GET')).length).toBe(1)
  })
})

describe('D5: an upload that goes quiet resumes from the byte Drive kept', () => {
  it('D5: detected at the stall time; Drive is asked what it has; the rest is sent from there; the file is exact', async () => {
    const s = await serve({ onPut: (r) => (r.n === 0 ? { do: 'hold', after: MiB } : { do: 'serve' }) })
    const steps: string[] = []
    const lines: string[] = []
    const sent: number[] = []
    const info = await adapter(s).writeNew('logs/up.wpilog', bytesSource(FILE), { sha256: sha(FILE), onStep: (w) => steps.push(w), log: (l) => lines.push(l), onProgress: (n) => sent.push(n) })
    expect(info.sha256).toBe(sha(FILE))
    expect(sha(s.uploaded!)).toBe(sha(FILE))
    expect(s.log.filter((l) => l.startsWith('PUT'))).toEqual([`PUT bytes 0-${FILE.length - 1}/${FILE.length}`, `PUT bytes */${FILE.length}`, `PUT bytes ${MiB}-${FILE.length - 1}/${FILE.length}`])
    expect(steps).toEqual(['Google Drive stopped taking data; trying again (try 2 of 3)'])
    expect(lines).toContain(`upload resumes at byte ${MiB} (Drive kept ${MiB} more)`)
    // Bytes counted as the connection took them, in pieces, never going back.
    expect(sent.length).toBeGreaterThan(2)
    expect(sent.every((n, i) => i === 0 || n >= sent[i - 1])).toBe(true)
  })
  it('D5: a dropped connection mid-upload resumes the same way', async () => {
    const s = await serve({ onPut: (r) => (r.n === 0 ? { do: 'drop', after: 2 * MiB } : { do: 'serve' }) })
    await adapter(s).writeNew('logs/up.wpilog', bytesSource(FILE), { sha256: sha(FILE) })
    expect(sha(s.uploaded!)).toBe(sha(FILE))
    expect(s.log.filter((l) => l.startsWith('PUT bytes 2'))).toEqual([`PUT bytes ${2 * MiB}-${FILE.length - 1}/${FILE.length}`])
  })
  it('D5: Drive taking more each time starts the count again; taking nothing three times is LinkLost in words', async () => {
    const moving = await serve({ onPut: (r) => (r.n < 4 ? { do: 'hold', after: MiB / 2 } : { do: 'serve' }) })
    await adapter(moving).writeNew('logs/up.wpilog', bytesSource(FILE), { sha256: sha(FILE) })
    expect(sha(moving.uploaded!)).toBe(sha(FILE))
    const dead = await serve({ onPut: (r) => (r.n === 0 ? { do: 'hold', after: MiB } : { do: 'silent' }) })
    const e = await adapter(dead).writeNew('logs/up.wpilog', bytesSource(FILE)).catch((x) => x)
    expect(e).toBeInstanceOf(LinkLost)
    expect(e.reason).toBe('Google Drive took no data for 0.3 s, at 1.0 of 3.0 MB; tried 3 times')
    expect(dead.uploaded).toBeNull()
  })
  it('D5: a non-retried request that stalls fails with Stalled words, not a hang', async () => {
    const s = await serve()
    const never: typeof fetch = (input, init) => (String(input).includes('/copy') ? new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))) : s.fetch(input, init))
    const store = new DriveAdapter({ rootId: 'root', token: async () => 'good', fetch: never, sleep: async () => {}, stallMs: STALL })
    const e = await store.copyInto('src1', 'logs/c.wpilog').catch((x) => x)
    expect(e).toBeInstanceOf(Stalled)
    expect(e.message).toBe('no answer from Google Drive for 0.3 s')
  })
})
