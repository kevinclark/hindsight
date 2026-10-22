// Ingest over a temp folder: copies, a renamed AdvantageKit log, a stub, DS logs that do and don't overlap, an undated
// log and an unreadable file; then the same ingest again, which must write nothing.
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ingest, localFolderFiles, type IngestReport } from '../src/hub/ingest.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { dsEvents, dsLog, robotLog } from './helpers/hub-logs.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0) // 2026-10-17 12:00 Pacific
const ENABLED: [number, number] = [20, 55]

let work: string
let source: string
let sourceBefore: string[]
let libRoot: string

async function put(rel: string, bytes: Uint8Array | string, mtime = new Date(CLOCK)): Promise<void> {
  const path = join(source, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  const { utimes } = await import('node:fs/promises')
  await utimes(path, mtime, mtime)
}

/** Every file in the library with its size and modified time: a re-run must leave this unchanged. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await walk(p)
      else { const s = await stat(p); out.push(`${p.slice(root.length)} ${s.size} ${s.mtimeMs}`) }
    }
  }
  await walk(root)
  return out.sort()
}

const options = { describe: describeFile }
const run = async (lib: LocalLibrary): Promise<IngestReport> => ingest(lib, await localFolderFiles(source), options)

describe('ingesting a folder of unorganized logs', () => {
  let first: IngestReport
  let lib: LocalLibrary

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'hindsight-ingest-'))
    source = join(work, 'laptop')
    libRoot = join(work, 'library')
    const match = robotLog({ clockMs: CLOCK, enabled: ENABLED, event: 'TEST', fms: true, matchType: 2, matchNumber: 7, battery: 'B01' })
    await put('day one/akit_26-10-17_19-00-00_test_q7.wpilog', match)
    await put('zcopies/my copy of the match.wpilog', match) // the same bytes under another name
    // A renamed log whose robot clock was never set (the roboRIO image date): only the name has the date, read as UTC in 2026.
    await put('misc/renamed.wpilog', robotLog({ clockMs: Date.UTC(2024, 11, 18), enabled: ENABLED, seed: 'unset clock' }))
    await put('misc/akit_26-10-18_01-30-00_practice.wpilog', robotLog({ clockMs: Date.UTC(2024, 11, 18), enabled: ENABLED, seed: 'named' }))
    await put('misc/akit_deadbeef.wpilog', robotLog({ seed: 'stub' })) // never enabled, tiny
    await put('misc/Log_2.wpilog', robotLog({ enabled: ENABLED, seed: 'undated' })) // enabled, but no clock and no date in the name
    await put('misc/broken.wpilog', 'not a log at all')
    await put('misc/notes.txt', 'ignore me')
    const wall = CLOCK / 1000 + ENABLED[0]
    await put('ds/overlaps.dslog', dsLog(wall - 3, 40))
    await put('ds/elsewhere.dslog', dsLog(wall + 7200, 40))
    await put('ds/overlaps.dsevents', dsEvents(wall - 3, 40))
    await put('ds/rio_2026-10-17_19-00-05.hoot', 'hoot bytes, never opened')
    lib = await LocalLibrary.open(libRoot, 'machine-a')
    sourceBefore = await snapshot(source)
    first = await run(lib)
  })
  afterAll(() => rm(work, { recursive: true, force: true }))

  it('files each log by what it says: school year, local date, original name', async () => {
    const paths = first.added.map((a) => a.path).sort()
    expect(paths).toContain('logs/2026-2027/2026-10-17/akit_26-10-17_19-00-00_test_q7.wpilog')
    expect(paths).toContain('logs/2026-2027/2026-10-17/akit_26-10-18_01-30-00_practice.wpilog')
    expect(paths).toContain('logs/2026-2027/2026-10-17/rio_2026-10-17_19-00-05.hoot')
    expect(await stat(join(libRoot, 'logs/2026-2027/2026-10-17/akit_26-10-17_19-00-00_test_q7.wpilog'))).toBeTruthy()
  })

  it('reads the match from the log, not the name', () => {
    const r = lib.catalog.all().find((x) => x.names.includes('akit_26-10-17_19-00-00_test_q7.wpilog'))!
    expect(r).toMatchObject({ event: 'TEST', matchType: 2, matchNumber: 7, onField: true, batteryId: 'B01', dateSource: 'robot clock', stub: false })
    expect(r.playedAt).toBe(CLOCK + 20_000)
  })

  it('takes the date of a log with an unset robot clock from its name, read as UTC in 2026', () => {
    const r = lib.catalog.all().find((x) => x.names.includes('renamed.wpilog'))!
    expect(r.dateSource).toBe('unknown') // no date in "renamed.wpilog" and the clock is the image date
    expect(r.path).toBe('logs/undated/renamed.wpilog')
    const named = lib.catalog.all().find((x) => x.names[0].startsWith('akit_26-10-18'))!
    expect(named.dateSource).toBe('file name')
    expect(named.playedAt).toBe(Date.UTC(2026, 9, 18, 1, 30, 0))
  })

  it('reports the same bytes under two names as one log, with both names', () => {
    const dup = first.already.find((a) => a.name === 'my copy of the match.wpilog')!
    expect(dup).toMatchObject({ path: 'logs/2026-2027/2026-10-17/akit_26-10-17_19-00-00_test_q7.wpilog', newName: true })
    expect(dup.names.sort()).toEqual(['akit_26-10-17_19-00-00_test_q7.wpilog', 'my copy of the match.wpilog'])
    expect(lib.catalog.size).toBe(first.added.length)
  })

  it('flags the stub, the undated log and the unreadable file, and ignores non-logs', () => {
    expect(first.added.find((a) => a.name === 'akit_deadbeef.wpilog')).toMatchObject({ stub: true })
    expect(first.added.filter((a) => a.undated).map((a) => a.name).sort()).toEqual(['Log_2.wpilog', 'akit_deadbeef.wpilog', 'renamed.wpilog'])
    expect(first.added.find((a) => a.name === 'Log_2.wpilog')!.path).toBe('logs/undated/Log_2.wpilog')
    expect(first.unreadable).toEqual([expect.objectContaining({ name: 'broken.wpilog', reason: expect.stringMatching(/Not a \.wpilog/) })])
    expect(first.ignored).toBe(1)
  })

  it('attaches the DS log and events that overlap the match, not the one an hour later; the hoot file by its name', () => {
    const match = lib.catalog.entries().find((e) => e.names.includes('akit_26-10-17_19-00-00_test_q7.wpilog'))!
    expect(match.attached.dslog.map((r) => r.names[0])).toEqual(['overlaps.dslog'])
    expect(match.attached.dsevents.map((r) => r.names[0])).toEqual(['overlaps.dsevents'])
    expect(match.attached.hoot.map((r) => r.names[0])).toEqual(['rio_2026-10-17_19-00-05.hoot'])
    const stray = lib.catalog.all().find((r) => r.names[0] === 'elsewhere.dslog')!
    expect(lib.catalog.entries().flatMap((e) => e.attached.dslog).includes(stray)).toBe(false)
  })

  it('never touches the originals', async () => {
    expect(await snapshot(source)).toEqual(sourceBefore) // every file's size and modified time, and no new file
    const files = await localFolderFiles(source)
    expect(files.length).toBe(12)
    expect((await readFile(join(source, 'misc/notes.txt'), 'utf8'))).toBe('ignore me')
    expect((await stat(join(source, 'day one/akit_26-10-17_19-00-00_test_q7.wpilog'))).mtimeMs).toBe(CLOCK)
  })

  it('a second run reports everything as already there and writes nothing', async () => {
    const before = await snapshot(libRoot)
    const again = await run(lib)
    expect(again.added).toEqual([])
    expect(again.already.length).toBe(first.added.length + first.already.length)
    expect(again.already.every((a) => !a.newName)).toBe(true)
    expect(again.unreadable.map((u) => u.name)).toEqual(['broken.wpilog'])
    expect(await snapshot(libRoot)).toEqual(before)
    // And from a fresh start (no memory of the first run), reading the manifest from disk.
    const reopened = await LocalLibrary.open(libRoot, 'machine-a')
    const third = await run(reopened)
    expect(third.added).toEqual([])
    expect(await snapshot(libRoot)).toEqual(before)
  })

  it('files a different log with a name already taken under the name plus its sha-256 start', async () => {
    const clash = robotLog({ clockMs: CLOCK, enabled: ENABLED, seed: 'different bytes' })
    await put('later/akit_26-10-17_19-00-00_test_q7.wpilog', clash)
    const report = await run(lib)
    const added = report.added.find((a) => a.name === 'akit_26-10-17_19-00-00_test_q7.wpilog')!
    expect(added.path).toMatch(/^logs\/2026-2027\/2026-10-17\/akit_26-10-17_19-00-00_test_q7-[0-9a-f]{8}\.wpilog$/)
  })

  it("does not file a log at a path another machine's log holds, though that file is not on this disk", async () => {
    const lib4 = await LocalLibrary.open(join(work, 'library-four'), 'machine-d')
    const theirs = robotLog({ enabled: ENABLED, seed: 'theirs' })
    await lib4.append({ type: 'log', kind: 'wpilog', playedAt: null, dateSource: 'unknown', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null, onField: false, batteryId: null, robot: null, build: null, stub: false, hardwareId: null,
      sha256: 'ee'.repeat(32), size: theirs.length, path: 'logs/undated/Log_2.wpilog', names: ['Log_2.wpilog'], modifiedTime: null, from: 'folder', recordedAt: 1, machine: 'someone-else' })
    const rep = await ingest(lib4, (await localFolderFiles(join(source, 'misc'))).filter((f) => f.name === 'Log_2.wpilog'), options)
    expect(rep.added[0].path).toMatch(/^logs\/undated\/Log_2-[0-9a-f]{8}\.wpilog$/)
    expect(lib4.catalog.byPath('logs/undated/Log_2.wpilog')!.sha256).toBe('ee'.repeat(32))
  })

  it('does not read a file again that would not read, until it changes', async () => {
    const seen = new Map<string, string>()
    let reads = 0
    const counting = { describe: (p: string, n: string) => { reads++; return describeFile(p, n) }, seen }
    const lib2 = await LocalLibrary.open(join(work, 'library-two'), 'machine-b')
    const files = await localFolderFiles(join(source, 'misc'))
    const first2 = await ingest(lib2, files.filter((f) => f.name === 'broken.wpilog'), counting)
    const again = await ingest(lib2, files.filter((f) => f.name === 'broken.wpilog'), counting)
    expect(first2.unreadable[0].reason).toMatch(/Not a \.wpilog/)
    expect(again.unreadable[0].reason).toBe(first2.unreadable[0].reason)
    expect(reads).toBe(1)
    await put('misc/broken.wpilog', 'changed, still not a log')
    await ingest(lib2, await localFolderFiles(join(source, 'misc')).then((fs) => fs.filter((f) => f.name === 'broken.wpilog')), counting)
    expect(reads).toBe(2)
  })

  it('counts a symlink to a log as the log, and does not follow a symlink to a folder', async () => {
    const { symlink } = await import('node:fs/promises')
    await mkdir(join(source, 'links'), { recursive: true })
    await symlink(join(source, 'misc/Log_2.wpilog'), join(source, 'links/linked.wpilog'))
    await symlink(source, join(source, 'links/loop'))
    const files = await localFolderFiles(source)
    expect(files.filter((f) => f.name === 'linked.wpilog').length).toBe(1)
    expect(files.filter((f) => f.where.includes('/loop/')).length).toBe(0)
  })

  it('starts a fresh line after a crash left the manifest without its last newline', async () => {
    const lib3 = await LocalLibrary.open(join(work, 'library-three'), 'machine-c')
    await lib3.append({ type: 'alias', sha256: 'aa', name: 'one', recordedAt: 1, machine: 'machine-c' })
    await writeFile(join(work, 'library-three/manifests/machine-c.jsonl'), '{"type":"alias","sha256":"aa","name":"one","recordedAt":1,"machine":"machine-c"}\n{"type":"alias","sha')
    const reopened = await LocalLibrary.open(join(work, 'library-three'), 'machine-c')
    await reopened.append({ type: 'alias', sha256: 'bb', name: 'two', recordedAt: 2, machine: 'machine-c' })
    const again = await LocalLibrary.open(join(work, 'library-three'), 'machine-c')
    expect(again.catalog.namesOf('bb')).toEqual([]) // aliases of unknown logs are kept, not listed
    expect(again.catalog.skipped).toBe(1) // only the cut-off line is lost
  })

  it('recovers a copy filed before its record was written (a crash) without making a second copy', async () => {
    const crashed = robotLog({ clockMs: CLOCK + 3600e3, enabled: ENABLED, seed: 'crash' })
    await put('crash/c.wpilog', crashed)
    await mkdir(join(libRoot, 'logs/2026-2027/2026-10-17'), { recursive: true })
    await writeFile(join(libRoot, 'logs/2026-2027/2026-10-17/c.wpilog'), crashed) // the copy exists, the record doesn't
    const report = await run(lib)
    expect(report.added.find((a) => a.name === 'c.wpilog')!.path).toBe('logs/2026-2027/2026-10-17/c.wpilog')
    expect((await readdir(join(libRoot, 'logs/2026-2027/2026-10-17'))).filter((n) => n.startsWith('c'))).toEqual(['c.wpilog'])
  })
})
