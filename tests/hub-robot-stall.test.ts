// A robot pull that never stalls silently: a real ssh2 SFTP server on 127.0.0.1 that goes quiet or drops mid-file, and the
// pull noticing, reconnecting, resuming from the bytes already written, or stopping in words. Invented files only.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KEEPALIVE, STALL_MS, TRIES, Stalled, connectRobotFs, parseAddress, robotFiles, type RobotFs } from '../src/hub/robot.ts'
import { LinkLost, Stopped } from '../src/hub/adapter.ts'
import { ingest } from '../src/hub/ingest.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { openSeen } from '../src/hub/seen.ts'
import { robotLog } from './helpers/hub-logs.ts'
import { startSftpServer, type SftpServer, type SftpServerOptions } from './helpers/sftp-server.ts'

// A broken detector must fail under its own P-id name: GitHub's runner takes 7-9 s on several of these (2026-11-08), so 45 s, under the 60 s default.
vi.setConfig({ testTimeout: 45_000 })

const cleanups: (() => unknown)[] = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const tmp = async () => { const d = await mkdtemp(join(tmpdir(), 'hindsight-stall-')); cleanups.push(() => rm(d, { recursive: true, force: true })); return d }
const serve = async (o: SftpServerOptions): Promise<SftpServer> => { const s = await startSftpServer(o); cleanups.push(() => s.close()); return s }
const connect = async (s: SftpServer, o: Parameters<typeof connectRobotFs>[1] = {}): Promise<RobotFs> => {
  const fs = await connectRobotFs(`127.0.0.1:${s.port}`, { stallMs: 500, connectMs: 3000, ...o })
  cleanups.push(() => fs.close())
  return fs
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = async (check: () => boolean, ms = 5000) => { const t = Date.now(); while (!check()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(20) } }

/** 1.5 MB that tells any misplaced byte: each 4-byte word is its own offset. */
const BIG = (() => { const b = Buffer.alloc(1_500_000); for (let i = 0; i + 4 <= b.length; i += 4) b.writeUInt32LE(i / 4, i); return b })()
const F = '/home/lvuser/logs/a.bin'
const HOLD_AT = 700_000

describe('P1: the ssh link is watched', () => {
  it('P1: keepalive is configured at 5 s x 3 (a dead link is noticed in ~15 s)', () => {
    expect(KEEPALIVE).toEqual({ keepaliveInterval: 5000, keepaliveCountMax: 3 })
  })
  it('P1: an idle connection really sends keepalives (the server receives bytes from a client that asked for nothing)', async () => {
    const s = await serve({ files: { [F]: BIG } })
    await connect(s)
    await sleep(500) // the handshake and SFTP start are over
    const quiet = s.bytesReceived()
    await sleep(6000) // one 5 s keepalive interval
    expect(s.bytesReceived()).toBeGreaterThan(quiet)
  }, 15_000)
  it('names the defaults: 15 s stall, 3 tries, host:port with 22 as the robot default', () => {
    expect([STALL_MS, TRIES]).toEqual([15_000, 3])
    expect(parseAddress('10.80.33.2')).toEqual({ host: '10.80.33.2', port: 22 })
    expect(parseAddress('roboRIO-8033-FRC.local')).toEqual({ host: 'roboRIO-8033-FRC.local', port: 22 })
    expect(parseAddress('127.0.0.1:2222')).toEqual({ host: '127.0.0.1', port: 2222 })
  })
})

describe('P2: a quiet link fails the download, in words', () => {
  it('P2: no bytes for the stall time fails with how long and at how many bytes', async () => {
    const s = await serve({ files: { [F]: BIG }, chunk: 32768, onRead: (r) => (r.offset >= HOLD_AT ? 'hold' : 'serve') })
    const fs = await connect(s, { tries: 1 })
    const t = Date.now()
    const err = await fs.download(F, join(await tmp(), 'a.bin'), {}, BIG.length).catch((e) => e)
    const took = Date.now() - t
    expect(err).toBeInstanceOf(LinkLost)
    expect((err as LinkLost).cause).toBeInstanceOf(Stalled)
    expect((err as Error).message).toMatch(/^no data from the robot for 0\.5 s, at (0\.[6-9]|1\.[0-5]) of 1\.4 MB; tried 1 time$/)
    expect(took).toBeGreaterThanOrEqual(450)
    expect(took).toBeLessThan(6000) // detected at the injected 500 ms, not at 15 s (a busy CI runner adds seconds)
  })

  it('P2: a connection dropped mid-file fails it at once, without waiting for the stall time', async () => {
    const s = await serve({ files: { [F]: BIG }, chunk: 32768, onRead: (r) => (r.offset >= HOLD_AT ? 'drop' : 'serve') })
    const fs = await connect(s, { tries: 1, stallMs: 30_000 })
    const t = Date.now()
    const err = await fs.download(F, join(await tmp(), 'a.bin'), {}, BIG.length).catch((e) => e)
    expect(err).toBeInstanceOf(LinkLost)
    expect(((err as LinkLost).cause as Error).message).toMatch(/connection to the robot closed/)
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('P3: a listing that does not answer fails the same way', () => {
  it('P3: readdir held unanswered fails with Stalled at the stall time', async () => {
    const s = await serve({ files: {}, dirs: { '/home/lvuser/logs': [] }, onReaddir: () => 'hold' })
    const fs = await connect(s)
    const t = Date.now()
    const err = await fs.list('/home/lvuser/logs').catch((e) => e)
    expect(err).toBeInstanceOf(Stalled)
    expect((err as Error).message).toBe('no answer from the robot for 0.5 s listing /home/lvuser/logs')
    expect(Date.now() - t).toBeGreaterThanOrEqual(450)
    expect(Date.now() - t).toBeLessThan(2500)
  })
  it('P6: Stop during a held listing answers promptly (stall time 5 s)', async () => {
    const s = await serve({ files: {}, dirs: { '/home/lvuser/logs': [] }, onReaddir: () => 'hold' })
    const fs = await connect(s, { stallMs: 5000 })
    let stop = false
    const run = fs.list('/home/lvuser/logs', () => stop).catch((e) => e)
    await sleep(300)
    const pressed = Date.now()
    stop = true
    expect(await run).toBeInstanceOf(Stopped)
    expect(Date.now() - pressed).toBeLessThan(1500)
  })
  it('P6: robotFiles passes Stop to the listing', async () => {
    const s = await serve({ files: {}, dirs: { '/home/lvuser/logs': [] }, onReaddir: () => 'hold' })
    const fs = await connect(s, { stallMs: 5000 })
    let stop = false
    const run = robotFiles(fs, { now: () => 0, sleep: async () => {}, cancelled: () => stop }).catch((e) => e)
    await sleep(300)
    stop = true
    expect(await run).toBeInstanceOf(Stopped)
  })
  it('P3: robotFiles does not mistake a silent robot for a folder that is not there', async () => {
    const s = await serve({ files: {}, dirs: { '/home/lvuser/logs': [] }, onReaddir: () => 'hold' })
    const fs = await connect(s)
    await expect(robotFiles(fs, { now: () => 0, sleep: async () => {} })).rejects.toBeInstanceOf(Stalled)
  })
  it('P3: a folder that is not there (no USB stick) is still not an error', async () => {
    const s = await serve({ files: {}, dirs: { '/home/lvuser/logs': [] } })
    const fs = await connect(s)
    expect((await robotFiles(fs, { now: () => 0, sleep: async () => {} })).files).toEqual([])
  })
})

describe('P4: reconnect and resume', () => {
  const stalledOnce = (verdict: 'hold' | 'drop') => ({ files: { [F]: BIG }, chunk: 32768, onRead: (r: { conn: number; offset: number }) => (r.conn === 1 && r.offset >= HOLD_AT ? verdict : 'serve') as 'serve' | 'hold' | 'drop' })

  for (const verdict of ['hold', 'drop'] as const) {
    it(`P4: a link that ${verdict === 'hold' ? 'goes quiet' : 'drops'} mid-file is reconnected and the file resumed to a byte-identical copy`, async () => {
      const s = await serve(stalledOnce(verdict))
      const lines: string[] = []
      const fs = await connect(s, { log: (l) => lines.push(l) })
      const local = join(await tmp(), 'a.bin')
      const steps: string[] = []
      const progress: number[] = []
      const events: (number | string)[] = []
      await fs.download(F, local, { onStep: (w) => { steps.push(w); events.push(`step:${w.split(';')[0]}`) }, onProgress: (n) => { progress.push(n); events.push(n) } }, BIG.length)

      expect((await readFile(local)).equals(BIG)).toBe(true)
      // The words of the retry, in the job step.
      expect(steps[0]).toBe('Robot stopped sending; reconnecting (try 2 of 3)')
      expect(steps.some((w) => /^Reconnected; resuming at [\d.]+ MB \(try 2 of 3\)$/.test(w))).toBe(true)
      // P4/P11: after "Reconnected; resuming" no byte report comes until bytes pass what was already reported, so the words stay (a report at the resume offset would overwrite them and dip the bar).
      const at = events.indexOf('step:Reconnected')
      expect(at).toBeGreaterThan(0)
      const before = Math.max(...events.slice(0, at).filter((e): e is number => typeof e === 'number'))
      const after = events.slice(at + 1).filter((e): e is number => typeof e === 'number')
      expect(after.length).toBeGreaterThan(0)
      expect(Math.min(...after)).toBeGreaterThan(before)
      // The server saw a second connection whose first READ starts at the resume offset, not at 0.
      expect(s.connections).toBe(2)
      const second = s.reads.filter((r) => r.conn === 2)
      expect(second[0].offset).toBeGreaterThan(0)
      expect(second[0].offset).toBeLessThanOrEqual(HOLD_AT + 65536)
      expect(lines.some((l) => l === `reconnected; resume ${F} at offset ${second[0].offset}`)).toBe(true)
      // Nothing before the resume offset was asked for again.
      expect(Math.min(...second.map((r) => r.offset))).toBe(second[0].offset)
      // The byte count never falls back, and it ends at the whole file.
      for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1])
      expect(progress.at(-1)).toBe(BIG.length)
      expect(lines.some((l) => /^(stall|link lost) \(try 1 of 3\): /.test(l))).toBe(true)
    })
  }

  it('P4: three tries in all, each retry worded with its number', async () => {
    const s = await serve({ files: { [F]: BIG }, chunk: 32768, onRead: (r) => (r.conn < 3 && r.offset >= HOLD_AT ? 'hold' : 'serve') })
    const fs = await connect(s, { stallMs: 1500 })
    const local = join(await tmp(), 'a.bin')
    const steps: string[] = []
    await fs.download(F, local, { onStep: (w) => steps.push(w) }, BIG.length)
    expect(steps.filter((w) => /^Robot stopped/.test(w))).toEqual(['Robot stopped sending; reconnecting (try 2 of 3)', 'Robot stopped sending; reconnecting (try 3 of 3)'])
    expect((await readFile(local)).equals(BIG)).toBe(true)
  })
})

describe('P5: after the last try the pull stops, in words', () => {
  it('P5: a download that never recovers throws LinkLost after 3 tries', async () => {
    const s = await serve({ files: { [F]: BIG }, chunk: 32768, onRead: (r) => (r.offset >= HOLD_AT ? 'hold' : 'serve') })
    const fs = await connect(s, { stallMs: 1500 })
    const err = await fs.download(F, join(await tmp(), 'a.bin'), {}, BIG.length).catch((e) => e)
    expect(err).toBeInstanceOf(LinkLost)
    expect((err as Error).message).toMatch(/^no data from the robot for 1\.5 s, at [\d.]+ of 1\.4 MB; tried 3 times$/)
    expect(s.connections).toBe(3)
  })

  it('P5: ingest stops the whole pull at that file, names it, keeps what is done, and remembers nothing wrong; a retry resumes there', async () => {
    const A = robotLog({ clockMs: Date.UTC(2026, 9, 17), enabled: [2, 4], seed: 'stall a' })
    const B = robotLog({ clockMs: Date.UTC(2026, 9, 17), enabled: [2, 4], seed: 'stall b' })
    const C = robotLog({ clockMs: Date.UTC(2026, 9, 17), enabled: [2, 4], seed: 'stall c' })
    expect(B.length).toBeGreaterThan(160) // spans several 64-byte reads, so b can stall part way
    const NOW = Date.UTC(2026, 9, 17, 20)
    const dir = '/home/lvuser/logs'
    const entry = (name: string, b: Uint8Array) => ({ name, size: b.length, mtimeMs: NOW - 3600e3 })
    const files = { [`${dir}/a.wpilog`]: A, [`${dir}/b.wpilog`]: B, [`${dir}/c.wpilog`]: C }
    const dirs = { [dir]: [entry('a.wpilog', A), entry('b.wpilog', B), entry('c.wpilog', C)] }

    const lib = await LocalLibrary.open(await tmp(), 'machine-a')
    const seenPath = join(await tmp(), 'seen.json')
    const seen = await openSeen(seenPath)
    const pull = async (server: SftpServer, o: { cancelled?: () => boolean } = {}) => {
      const fs = await connect(server, { stallMs: 1500, tries: 2 })
      const { files: found } = await robotFiles(fs, { now: () => NOW, sleep: async () => {}, tempRoot: await tmp() })
      return ingest(lib, found, { describe: describeFile, seen, afterEach: () => seen.save(), ...o })
    }

    const broken = await serve({ files, dirs, chunk: 64, onRead: (r) => (r.path.endsWith('b.wpilog') && r.offset >= 128 ? 'hold' : 'serve') })
    const first = await pull(broken)
    expect(first.stopped).toBe(true)
    expect(first.lostLink).toMatch(/^Stopped at file 2 of 3 \(b\.wpilog\): no data from the robot for 1\.5 s, at 0\.0 of 0\.0 MB; tried 2 times\. 1 of the robot's 3 logs are in the library \(1 added this pull\)\. Pull again to continue from here\.$/)
    expect(first.added.map((e) => e.name)).toEqual(['a.wpilog'])
    expect(first.unreadable).toEqual([]) // b is not "unreadable"
    expect(first.notTried).toBe(2)
    expect(broken.reads.some((r) => r.path.endsWith('c.wpilog'))).toBe(false) // c was never tried
    const remembered = JSON.parse(await readFile(seenPath, 'utf8')) as Record<string, string>
    expect(Object.keys(remembered)).toHaveLength(1)
    expect(Object.values(remembered).some((v) => v.startsWith('unreadable:'))).toBe(false)

    // The retry: a is not downloaded again; b and c come.
    const healthy = await serve({ files, dirs, chunk: 64 })
    const again = await pull(healthy)
    expect(again.lostLink).toBeUndefined()
    expect(healthy.reads.some((r) => r.path.endsWith('a.wpilog'))).toBe(false)
    expect(again.added.map((e) => e.name)).toEqual(['b.wpilog', 'c.wpilog'])
    expect(again.already.map((e) => e.name)).toEqual(['a.wpilog'])
  })
})

describe('P6: Stop works at every point', () => {
  it('P6: during a stall wait (the stall time is 5 s; Stop answers in well under 1.5 s)', async () => {
    const s = await serve({ files: { [F]: BIG }, chunk: 32768, onRead: (r) => (r.offset >= HOLD_AT ? 'hold' : 'serve') })
    const fs = await connect(s, { stallMs: 5000 })
    let stop = false
    const run = fs.download(F, join(await tmp(), 'a.bin'), { cancelled: () => stop }, BIG.length).catch((e) => e)
    await until(() => s.reads.some((r) => r.offset >= HOLD_AT))
    await sleep(300)
    const pressed = Date.now()
    stop = true
    expect(await run).toBeInstanceOf(Stopped)
    expect(Date.now() - pressed).toBeLessThan(1500)
  })

  it('P6: during a reconnect (the new connection is never answered; Stop does not wait for the 10 s)', async () => {
    const s = await serve({ files: { [F]: BIG }, chunk: 32768, onRead: (r) => (r.offset >= HOLD_AT ? 'hold' : 'serve'), onConnect: (n) => (n >= 2 ? 'ignore' : 'accept') })
    const fs = await connect(s, { connectMs: 10_000 })
    let stop = false
    let pressed = 0
    const run = fs.download(F, join(await tmp(), 'a.bin'), { cancelled: () => stop, onStep: (w) => { if (/reconnecting/.test(w) && !pressed) setTimeout(() => { pressed = Date.now(); stop = true }, 200) } }, BIG.length).catch((e) => e)
    expect(await run).toBeInstanceOf(Stopped)
    expect(s.connections).toBe(2) // it was reconnecting
    expect(Date.now() - pressed).toBeLessThan(1500)
  })

  it('P6: during a resume (the resumed read goes quiet too)', async () => {
    const s = await serve({ files: { [F]: BIG }, chunk: 32768, onRead: (r) => (r.offset >= HOLD_AT ? 'hold' : 'serve') })
    const fs = await connect(s, { stallMs: 1500 })
    let stop = false
    let pressed = 0
    const run = fs.download(F, join(await tmp(), 'a.bin'), { cancelled: () => stop, onStep: (w) => { if (/^Reconnected; resuming/.test(w) && !pressed) setTimeout(() => { pressed = Date.now(); stop = true }, 300) } }, BIG.length).catch((e) => e)
    expect(await run).toBeInstanceOf(Stopped)
    expect(Date.now() - pressed).toBeLessThan(1000) // the stall time (1.5 s) had not run out
    expect(s.connections).toBe(2)
  })
})

describe('P7: the size check still applies after a resume', () => {
  it('P7: a file that ends short after a resume is refused, not filed', async () => {
    const NOW = Date.UTC(2026, 9, 17, 20)
    const dir = '/home/lvuser/logs'
    const s = await serve({
      files: { [`${dir}/a.wpilog`]: BIG }, dirs: { [dir]: [{ name: 'a.wpilog', size: BIG.length, mtimeMs: NOW - 3600e3 }] }, chunk: 32768,
      onRead: (r) => (r.conn === 1 && r.offset >= HOLD_AT ? 'hold' : 'serve'),
      endOf: (conn, _p, size) => (conn >= 2 ? size - 1000 : size),
    })
    const fs = await connect(s)
    const { files: [f] } = await robotFiles(fs, { now: () => NOW, sleep: async () => {}, tempRoot: await tmp() })
    await expect(f.open()).rejects.toThrow(/the download stopped at \d+ of 1500000 bytes; pull again/)
    expect(s.connections).toBe(2) // it did resume first
  })
  it('P7: a file whose listing size is exact passes after a resume', async () => {
    const NOW = Date.UTC(2026, 9, 17, 20)
    const dir = '/home/lvuser/logs'
    const s = await serve({
      files: { [`${dir}/a.wpilog`]: BIG }, dirs: { [dir]: [{ name: 'a.wpilog', size: BIG.length, mtimeMs: NOW - 3600e3 }] }, chunk: 32768,
      onRead: (r) => (r.conn === 1 && r.offset >= HOLD_AT ? 'hold' : 'serve'),
    })
    const fs = await connect(s)
    const { files: [f] } = await robotFiles(fs, { now: () => NOW, sleep: async () => {}, tempRoot: await tmp() })
    const opened = await f.open()
    expect((await stat(opened.path)).size).toBe(BIG.length)
    expect((await readFile(opened.path)).equals(BIG)).toBe(true)
    await opened.done()
  })
})
