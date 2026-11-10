// Download from the team keeps the next range of a log on its way while the one before is hashed and written, so the
// wait before Drive starts sending a range overlaps bytes still arriving: the bar moves without a pause every piece.
process.env.TZ = 'America/Los_Angeles'

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogRecord } from '../src/hub/types.ts'
import { LinkLost, bytesSource, type StorageAdapter, type TransferWatch } from '../src/hub/adapter.ts'
import type { ProgressMore } from '../src/hub/jobs.ts'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { fetchLogs } from '../src/hub/sync.ts'

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
  it('asks for the next range while the one before is still arriving, and never more than two at once', async () => {
    const bytes = pattern(17 * MiB)
    const team = await teamWith(bytes)
    let inFlight = 0
    let most = 0
    const slow = withRead(team, async (path, start, end, watch) => {
      most = Math.max(most, ++inFlight)
      try { await wait(20); return await team.read(path, start, end) } finally { inFlight-- }
    })
    const lib = await LocalLibrary.open(join(work, 'mb'), 'mb')
    const report = await fetchLogs(lib, slow, [record(bytes)])
    expect(report.fetched).toEqual([PATH])
    expect(most).toBe(2)
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

  it('a range read ahead that nothing took is told to stop once the log fails, and its bytes no longer move the bar', async () => {
    const bytes = pattern(13 * MiB)
    const team = await teamWith(bytes)
    let held: TransferWatch | undefined
    const flaky = withRead(team, async (path, start, end, watch) => {
      if (start === 4 * MiB) throw new LinkLost('no data from Google Drive for 15 s')
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
    expect(events).toBe(before)
    expect(await readdir(join(lib.root, 'logs/2026-2027/2026-10-17'))).toEqual([])
  })
})
