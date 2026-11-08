// What a pull says and remembers: the seen memory saved after each file, the speed and "no data" words, and the job log.
process.env.TZ = 'America/Los_Angeles'

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JobLog, ROTATE_BYTES, isoWithOffset } from '../electron/job-log.ts'
import { Stopped } from '../src/hub/adapter.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { ingest, type SourceFile } from '../src/hub/ingest.ts'
import { JobRunner, fileMeter, summarize, type JobProgress } from '../src/hub/jobs.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { openSeen } from '../src/hub/seen.ts'
import { QUIET_MS, RATE_WINDOW_MS, STEP_WAIT_MS, formatRate, isArriving, noDataText, quietFor, quietSince, rateOver, stepWaitText, type Sample } from '../src/ui/job-bar.ts'
import { robotLog } from './helpers/hub-logs.ts'

let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-feedback-')) })
afterEach(() => rm(work, { recursive: true, force: true }))

const bytesOf = (seed: string) => robotLog({ clockMs: Date.UTC(2026, 9, 17), enabled: [2, 4], seed })
/** A source that "downloads" `bytes`, telling the watch as a robot transfer does. */
function source(name: string, bytes: Uint8Array, o: { open?: SourceFile['open'] } = {}): SourceFile {
  return {
    name, where: `robot:/logs/${name}`, size: bytes.length, modifiedTime: 1, from: 'robot', cacheKey: `robot:/logs/${name}|${bytes.length}|1`,
    open: o.open ?? (async (watch) => {
      const path = join(work, name)
      await writeFile(path, bytes)
      watch?.onProgress?.(bytes.length, bytes.length)
      return { path, done: async () => {} }
    }),
  }
}

describe('P8: the seen memory is saved after each file', () => {
  it('P8: stopped at file 2 of 3, seen.json already holds file 1 (and a retry starts at file 2)', async () => {
    const lib = await LocalLibrary.open(join(work, 'lib'), 'machine-a')
    const seenPath = join(work, 'seen.json')
    const seen = await openSeen(seenPath)
    const [a, b, c] = [bytesOf('one'), bytesOf('two'), bytesOf('three')]
    const saved: number[] = []
    const stopsAt2 = source('b.wpilog', b, { open: async () => { throw new Stopped() } })
    const report = await ingest(lib, [source('a.wpilog', a), stopsAt2, source('c.wpilog', c)], {
      describe: describeFile, seen,
      afterEach: async () => { await seen.save(); saved.push(Object.keys(JSON.parse(await readFile(seenPath, 'utf8').catch(() => '{}'))).length) },
    })
    expect(report.stopped).toBe(true)
    expect(report.added.map((e) => e.name)).toEqual(['a.wpilog'])
    // On disk after file 1 and still after the stop at file 2: nothing waited for "the end".
    expect(saved).toEqual([1, 1])
    const onDisk = JSON.parse(await readFile(seenPath, 'utf8')) as Record<string, string>
    expect(Object.keys(onDisk)).toEqual([`robot:/logs/a.wpilog|${a.length}|1`])

    // A fresh start from seen.json (the app quit and came back): file 1 is known, so only 2 and 3 are opened.
    const opened: string[] = []
    const watched = (f: SourceFile): SourceFile => ({ ...f, open: async (w) => { opened.push(f.name); return f.open(w) } })
    const again = await ingest(lib, [watched(source('a.wpilog', a)), watched(source('b.wpilog', b)), watched(source('c.wpilog', c))], { describe: describeFile, seen: await openSeen(seenPath) })
    expect(opened).toEqual(['b.wpilog', 'c.wpilog'])
    expect(again.added.map((e) => e.name)).toEqual(['b.wpilog', 'c.wpilog'])
  })

  it('P8: written atomically (no temp file left behind) and only when something changed', async () => {
    const seenPath = join(work, 'seen.json')
    const seen = await openSeen(seenPath)
    await seen.save()
    await expect(stat(seenPath)).rejects.toThrow() // nothing set, nothing written
    seen.set('k', 'sha')
    await seen.save()
    expect(JSON.parse(await readFile(seenPath, 'utf8'))).toEqual({ k: 'sha' })
    expect((await readdir(work)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('P9, P10: speed and "no data" words', () => {
  const at = (s: number, bytes: number): Sample => ({ at: s * 1000, bytes })

  it('P9: speed is the rate over the last 5 s, in MB/s or kB/s', () => {
    // 1 MiB/s for the first 5 s, then 4 MiB/s for the next 5: the window sees only the recent rate.
    const MiB = 2 ** 20
    const samples = Array.from({ length: 11 }, (_, t) => at(t, (t <= 5 ? t : 5 + (t - 5) * 4) * MiB))
    expect(RATE_WINDOW_MS).toBe(5000)
    expect(rateOver(samples)).toBeCloseTo(4 * 2 ** 20, -3)
    expect(formatRate(1.4 * 2 ** 20)).toBe('1.4 MB/s')
    expect(formatRate(320 * 1024)).toBe('320 kB/s')
    expect(formatRate(1024 ** 2 - 1)).toBe('1024 kB/s')
    expect(formatRate(100)).toBe('<1 kB/s')
    expect(formatRate(12 * 2 ** 20)).toBe('12.0 MB/s')
  })
  it('P9: no speed from under half a second of samples', () => {
    expect(rateOver([])).toBeNull()
    expect(rateOver([at(0, 0)])).toBeNull()
    expect(rateOver([at(0, 0), { at: 400, bytes: 10 }])).toBeNull()
  })

  it('P10: quiet time counts from the last time bytes grew, and the words wait for 3 s', () => {
    const samples = [at(0, 0), at(1, 100), at(2, 200), at(3, 200), at(4, 200)]
    expect(quietFor(samples, 9_000)).toBe(7000) // bytes last grew at t=2 s
    expect(noDataText(quietFor(samples, 9_000))).toBe('no data for 7 s')
    expect(QUIET_MS).toBe(3000)
    expect(noDataText(2999)).toBe('')
    expect(noDataText(3000)).toBe('no data for 3 s')
    // Seconds count up as the clock ticks, with no new samples.
    expect(noDataText(quietFor(samples, 10_000))).toBe('no data for 8 s')
    // It returns to the speed as soon as bytes move.
    expect(noDataText(quietFor([...samples, at(10, 900)], 10_200))).toBe('')
    expect(quietFor([], 5000)).toBe(0)
    expect(quietFor([at(0, 5)], 5000)).toBe(5000) // never moved since the first sample
  })
})

describe('review fixes: who may say "no data", and how long a step has waited', () => {
  const p = (file: { done: number; total: number } | undefined, o: { transfer?: boolean; current?: string; stopping?: boolean } = {}) => ({ file, current: 'a.wpilog', ...o })
  it('a network file can be quiet from its first byte; a folder file only once bytes have started', () => {
    expect(isArriving(p({ done: 0, total: 100 }, { transfer: true }))).toBe(true)
    expect(isArriving(p({ done: 0, total: 100 }))).toBe(false) // a local file being read: no byte count yet
    expect(isArriving(p({ done: 40, total: 100 }))).toBe(true)
  })
  it('never once the file is all in (it is being read here), with no file, no name, or while stopping', () => {
    expect(isArriving(p({ done: 100, total: 100 }, { transfer: true }))).toBe(false)
    expect(isArriving(p(undefined, { transfer: true }))).toBe(false)
    expect(isArriving(p({ done: 0, total: 0 }, { transfer: true }))).toBe(false)
    expect(isArriving(p({ done: 5, total: 100 }, { transfer: true, current: '' }))).toBe(false)
    expect(isArriving(p({ done: 5, total: 100 }, { transfer: true, stopping: true }))).toBe(false)
  })
  it('quiet time never counts from before this file began (the last file\'s reading is not this one\'s silence)', () => {
    const samples = [{ at: 0, bytes: 0 }, { at: 1000, bytes: 500 }]
    expect(quietSince(samples, 30_000, 25_000)).toBe(5000)
    expect(noDataText(quietSince(samples, 30_000, 25_000))).toBe('no data for 5 s')
    expect(quietSince(samples, 30_000, 0)).toBe(29_000)
  })
  it('a step held 3 s or more gets " · N s"; under that, nothing', () => {
    expect(STEP_WAIT_MS).toBe(3000)
    expect(stepWaitText(2999)).toBe('')
    expect(stepWaitText(3000)).toBe(' · 3 s')
    expect(stepWaitText(7400)).toBe(' · 7 s')
  })
  it('after a download the bar says Reading, then Filing, with the file bar still full; a folder add says neither', async () => {
    const lib = await LocalLibrary.open(join(work, 'lib'), 'machine-a')
    const a = bytesOf('steps')
    const seen: { step?: string; file?: number; transfer?: boolean }[] = []
    const onProgress = (_d: number, _t: number, _c: string, more?: { step?: string; file?: { done: number }; transfer?: boolean }) => seen.push({ step: more?.step, file: more?.file?.done, transfer: more?.transfer })
    await ingest(lib, [source('a.wpilog', a)], { describe: describeFile, onProgress })
    const steps = seen.filter((e) => e.step)
    expect(steps.map((e) => e.step)).toEqual(['Reading 1 of 1: a.wpilog', 'Filing 1 of 1: a.wpilog'])
    expect(steps.every((e) => e.file === a.length)).toBe(true)
    expect(seen.every((e) => e.transfer === true)).toBe(true) // robot source
    const dir = join(work, 'folder'); await (await import('node:fs/promises')).mkdir(dir)
    await writeFile(join(dir, 'f.wpilog'), bytesOf('folder'))
    const { localFolderFiles } = await import('../src/hub/ingest.ts')
    const local: typeof seen = []
    await ingest(lib, await localFolderFiles(dir), { describe: describeFile, onProgress: (_d, _t, _c, more) => local.push({ step: more?.step, transfer: more?.transfer }) })
    expect(local.some((e) => e.step)).toBe(false)
    expect(local.some((e) => e.transfer)).toBe(false)
  })
})

describe('P4 and P11: a step keeps the file\'s bytes', () => {
  it('the step words go out with the bytes so far, not 0', () => {
    const events: { done: number; step?: string; file?: number }[] = []
    const meter = fileMeter((_d, _t, _c, more) => events.push({ done: more?.bytes?.done ?? -1, step: more?.step, file: more?.file?.done }), [1000])
    const f = meter.start(0, 1, 'a.wpilog', 1000)
    f.at(600)
    f.step('Robot stopped sending; reconnecting (try 2 of 3)')
    f.at(700)
    expect(events.at(-2)).toEqual({ done: 600, step: 'Robot stopped sending; reconnecting (try 2 of 3)', file: 600 })
    expect(events.at(-1)).toEqual({ done: 700, step: undefined, file: 700 }) // the next byte clears it
  })
})

describe('P12: the job log', () => {
  it('P12: ISO time with the zone offset', () => {
    expect(isoWithOffset(Date.UTC(2026, 10, 8, 22, 3, 9, 120))).toBe('2026-11-08T14:03:09.120-08:00')
    expect(isoWithOffset(Date.UTC(2026, 6, 4, 12, 0, 0, 5))).toBe('2026-07-04T05:00:00.005-07:00')
  })

  it('P12: a pull writes start (name, version), steps, each file start and end, a stop, and the finish; no byte progress', async () => {
    const dir = join(work, 'logs')
    let t = Date.UTC(2026, 10, 8, 22, 0, 0)
    const log = new JobLog(dir, { now: () => (t += 1000) })
    const runner = new JobRunner(() => t, log, '0.1.999')
    const lib = await LocalLibrary.open(join(work, 'lib'), 'machine-a')
    const [a, b] = [bytesOf('log one'), bytesOf('log two')]
    const streamed = source('a.wpilog', a, { open: async (watch) => {
      const path = join(work, 'a.wpilog')
      await writeFile(path, a)
      watch?.onProgress?.(10, a.length); watch?.onProgress?.(a.length, a.length)
      watch?.log?.('stall (try 1 of 3): no data from the robot for 15 s, at 0.0 of 0.0 MB')
      watch?.log?.('reconnected; resume /logs/a.wpilog at offset 10')
      return { path, done: async () => {} }
    } })
    const events: (JobProgress | null)[] = []
    const report = await runner.run('Pulling logs off the robot', async (j, progress) => {
      progress(0, 0, '', { step: 'Connecting to 10.0.0.2' })
      return ingest(lib, [streamed, source('b.wpilog', b, { open: async () => { throw new Stopped() } })], { describe: describeFile, onProgress: progress, log: j.log })
    }, (p) => events.push(p))
    await log.flush()
    expect(report.stopped).toBe(true)
    const lines = (await readFile(log.path, 'utf8')).trimEnd().split('\n')
    const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}-08:00 /
    for (const l of lines) expect(l).toMatch(stamp)
    const text = lines.map((l) => l.replace(stamp, ''))
    expect(text[0]).toBe('job start: Pulling logs off the robot (Hindsight 0.1.999)')
    expect(text[1]).toBe('step: Connecting to 10.0.0.2')
    expect(text[2]).toBe(`file 1 of 2 start: a.wpilog, ${a.length} bytes`)
    expect(text).toContain('stall (try 1 of 3): no data from the robot for 15 s, at 0.0 of 0.0 MB')
    expect(text).toContain('reconnected; resume /logs/a.wpilog at offset 10')
    expect(text.find((l) => l.startsWith('file 1 of 2 end:'))).toMatch(new RegExp(`^file 1 of 2 end: a\\.wpilog: added, ${a.length} bytes, \\d+\\.\\d s, \\d+\\.\\d\\d MB/s average$`))
    expect(text).toContain(`file 2 of 2 start: b.wpilog, ${b.length} bytes`)
    expect(text.find((l) => l.startsWith('file 2 of 2 end:'))).toMatch(/^file 2 of 2 end: b\.wpilog: stopped, 0 bytes/)
    expect(text.at(-1)).toMatch(/^job finish: Pulling logs off the robot: stopped; .*added 1/)
    // Byte progress (10 bytes, then all of them) is not a line of its own.
    expect(lines.filter((l) => /progress/i.test(l))).toEqual([])
    expect(text).toContain('step: Reading 1 of 2: a.wpilog')
    expect(text).toContain('step: Filing 1 of 2: a.wpilog')
    expect(lines).toHaveLength(11)
  })

  it('P12: a lost link and an error are logged with their words, and a failed job says so', async () => {
    const log = new JobLog(join(work, 'logs'), { now: () => 0 })
    const runner = new JobRunner(() => 0, log, '1')
    await expect(runner.run('Pulling logs off the robot', async (j) => { j.log('reconnect: Robot stopped sending; reconnecting (try 2 of 3)'); throw new Error('no answer from the robot for 15 s listing /U/logs') }, () => {})).rejects.toThrow(/no answer/)
    await log.flush()
    const text = await readFile(log.path, 'utf8')
    expect(text).toMatch(/reconnect: Robot stopped sending; reconnecting \(try 2 of 3\)\n/)
    expect(text).toMatch(/error: no answer from the robot for 15 s listing \/U\/logs\n/)
    expect(text).toMatch(/job finish: Pulling logs off the robot: failed\n$/)
  })

  it('P12: rotates at the limit to jobs.1.log and keeps one old file', async () => {
    expect(ROTATE_BYTES).toBe(5 * 1024 * 1024)
    const dir = join(work, 'logs')
    const log = new JobLog(dir, { now: () => 0, rotateAt: 300 })
    for (let i = 0; i < 40; i++) log.line(`line ${i} ${'x'.repeat(40)}`)
    await log.flush()
    expect((await readdir(dir)).sort()).toEqual(['jobs.1.log', 'jobs.log'])
    const now = await readFile(join(dir, 'jobs.log'), 'utf8')
    const old = await readFile(join(dir, 'jobs.1.log'), 'utf8')
    expect(old.length).toBeGreaterThanOrEqual(300)
    expect(now.length).toBeLessThan(old.length + 100)
    expect(now.trimEnd().split('\n').at(-1)).toMatch(/line 39 /) // the newest line is in the live file
    expect(old).not.toMatch(/line 0 /) // one old file only: the oldest lines are gone
  })

  it('P12/P13: ensure() makes the file so the file manager can show it, and a line with a newline stays one line', async () => {
    const log = new JobLog(join(work, 'fresh', 'logs'), { now: () => 0 })
    expect(await log.ensure()).toBe(log.path)
    expect(await readFile(log.path, 'utf8')).toBe('')
    log.line('a\nb')
    await log.flush()
    expect((await readFile(log.path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('summarize: counts, lengths of lists, and a robot result\'s own words', () => {
    expect(summarize({ report: { added: [1, 2], already: [], unreadable: [], bytesAdded: 5, stopped: true, lostLink: 'because' }, stillWriting: [] })).toBe('stopped; added 2, already 0, unreadable 0, bytesAdded 5, lostLink: because')
    expect(summarize({ refused: 'The robot is enabled.' })).toBe('refused: The robot is enabled.')
  })
})
