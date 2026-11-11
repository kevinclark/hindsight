// ADR 15: a log whose record says the robot was never enabled stays on this laptop unless the user says to upload it.
// A record is published to teammates only once its file is on the team store, so a held-back log is simply not listed for them.
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { ingest, localFolderFiles } from '../src/hub/ingest.ts'
import { neverEnabled, planSync, syncWithTeam, notUploadedWords } from '../src/hub/sync.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { readText } from '../src/hub/adapter.ts'
import { parseManifest } from '../src/hub/types.ts'
import { robotLog } from './helpers/hub-logs.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0)
let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-held-')) })
afterEach(() => rm(work, { recursive: true, force: true }))

async function put(rel: string, seed: string, enabled?: [number, number], clock = CLOCK) {
  const path = join(work, 'src', rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, robotLog({ clockMs: clock, enabled, event: 'TEST', seed }))
  await utimes(path, new Date(clock), new Date(clock))
}
async function library() {
  await put('played.wpilog', 'played', [20, 55])
  await put('brief.wpilog', 'brief', [20, 20.02], CLOCK + 3600e3) // enabled for 0.02 s: still uploads
  await put('idle-one.wpilog', 'idle one', undefined, CLOCK + 7200e3)
  await put('idle-two.wpilog', 'idle two', undefined, CLOCK + 10800e3)
  const lib = await LocalLibrary.open(join(work, 'lib'), 'ma')
  await ingest(lib, await localFolderFiles(join(work, 'src')), { describe: describeFile })
  return lib
}
const nameOf = (lib: LocalLibrary, path: string) => lib.catalog.all().find((r) => r.path === path)!.names[0]

describe('a log the robot was never enabled in', () => {
  it('is a record whose runs say count 0; a record with no runs is not one', async () => {
    const lib = await library()
    const by = Object.fromEntries(lib.catalog.all().map((r) => [r.names[0], neverEnabled(r)]))
    expect(by).toEqual({ 'played.wpilog': false, 'brief.wpilog': false, 'idle-one.wpilog': true, 'idle-two.wpilog': true })
    const [r] = lib.catalog.all()
    const { runs: _runs, ...older } = r
    expect(neverEnabled(older as typeof r)).toBe(false)
  })

  it('stays on this laptop by default: not uploaded, not published, counted and sized', async () => {
    const lib = await library()
    const team = new MemoryAdapter()
    const idle = lib.catalog.all().filter(neverEnabled)
    const report = await syncWithTeam(lib, team)
    expect(report.uploaded.map((u) => nameOf(lib, u.path)).sort()).toEqual(['brief.wpilog', 'played.wpilog'])
    expect(report.neverEnabled).toEqual({ count: 2, bytes: idle.reduce((n, r) => n + r.size, 0) })
    expect(report.failed).toEqual([])
    expect(report.notTried).toBe(0)
    expect(report.alreadyThere).toBe(0)
    expect((await team.list('logs')).length).toBe(2)
    // Teammates are never told of a file that is not there: its record is not in the published manifest.
    const published = parseManifest((await readText(team, 'manifests/ma.jsonl'))!).records.filter((r) => r.type === 'log')
    expect(published.map((r) => r.names[0]).sort()).toEqual(['brief.wpilog', 'played.wpilog'])
    // A second sync says the same and sends nothing.
    const again = await syncWithTeam(lib, team)
    expect(again.uploaded).toEqual([])
    expect(again.neverEnabled.count).toBe(2)
  })

  it('is left out of the plan, and a teammate that syncs sees only what went up', async () => {
    const lib = await library()
    const team = new MemoryAdapter()
    expect((await planSync(lib, team)).uploads).toBe(2)
    expect((await planSync(lib, team, { includeNeverEnabled: true })).uploads).toBe(4)
    await syncWithTeam(lib, team)
    const mate = await LocalLibrary.open(join(work, 'mate'), 'mb')
    await syncWithTeam(mate, team)
    expect(mate.catalog.all().map((r) => r.names[0]).sort()).toEqual(['brief.wpilog', 'played.wpilog'])
    expect(mate.catalog.entries().every((e) => e.toFetch.length === 0 || e.shared)).toBe(true)
  })

  it('goes up when forced, then is no longer counted as held back', async () => {
    const lib = await library()
    const team = new MemoryAdapter()
    await syncWithTeam(lib, team)
    const forced = await syncWithTeam(lib, team, { includeNeverEnabled: true })
    expect(forced.uploaded.map((u) => nameOf(lib, u.path)).sort()).toEqual(['idle-one.wpilog', 'idle-two.wpilog'])
    expect(forced.neverEnabled).toEqual({ count: 0, bytes: 0 })
    expect(forced.alreadyThere).toBe(2)
    expect((await team.list('logs')).length).toBe(4)
    const published = parseManifest((await readText(team, 'manifests/ma.jsonl'))!).records.filter((r) => r.type === 'log')
    expect(published).toHaveLength(4)
    expect((await syncWithTeam(lib, team)).neverEnabled.count).toBe(0) // already there: nothing held back
  })

  it('is worded with the count, the size and where it stays', () => {
    expect(notUploadedWords(2, 63_000_000)).toBe('Not uploaded: 2 logs the robot was never enabled in, 63 MB, kept on this laptop.')
    expect(notUploadedWords(1, 2_500_000)).toBe('Not uploaded: 1 log the robot was never enabled in, 2.5 MB, kept on this laptop.')
  })
})
