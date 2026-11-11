// ADR 15: logs from power-ons that never had a Driver Station (AdvantageKit's hex-named files) are not pulled unless asked.
// The robot is a fake file system; the logs are invented.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { noDriverStationName, robotFiles, skippedWords, type RobotEntry, type RobotFs } from '../src/hub/robot.ts'
import { mb, sizeWords } from '../src/hub/transfer-watch.ts'
import { mb as phoneMb } from '../src/ui/phone-library.ts'
import { ingest } from '../src/hub/ingest.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { robotLog } from './helpers/hub-logs.ts'

const NOW = Date.UTC(2026, 9, 17, 12)
const HEX = 'akit_0123456789abcdef.wpilog'
const HEX2 = 'akit_fedcba9876543210.wpilog'
const DATED = 'akit_26-10-17_11-00-00.wpilog'
const DIR = '/home/lvuser/logs'

const file = (name: string, size = 100, age = 3600e3): RobotEntry => ({ name, size, mtimeMs: NOW - age, isDir: false })
function fakeRobot(entries: RobotEntry[], contents: Record<string, Uint8Array> = {}): RobotFs & { downloads: string[] } {
  const fs = {
    downloads: [] as string[],
    async list(dir: string) { if (dir !== DIR) throw new Error('no such folder'); return entries },
    async download(remote: string, local: string) { fs.downloads.push(remote); await writeFile(local, contents[remote] ?? Buffer.from(`bytes of ${remote}`)) },
    close() {},
  }
  return fs
}
const deps = async () => ({ now: () => NOW, sleep: async () => {}, tempRoot: await mkdtemp(join(tmpdir(), 'hindsight-skip-test-')) })

describe('the name of a log from a power-on with no Driver Station', () => {
  it('is akit_ and 16 hex digits and .wpilog, nothing else', () => {
    expect(noDriverStationName(HEX)).toBe(true)
    expect(noDriverStationName(DATED)).toBe(false) // renamed to a timestamp once the DS attached
    expect(noDriverStationName('akit_0123456789ABCDEF.wpilog')).toBe(false)
    expect(noDriverStationName('akit_0123456789abcde.wpilog')).toBe(false) // 15 digits
    expect(noDriverStationName('akit_0123456789abcdef0.wpilog')).toBe(false)
    expect(noDriverStationName('akit_0123456789abcdef.hoot')).toBe(false) // only .wpilog
    expect(noDriverStationName('akit_0123456789abcdef.dslog')).toBe(false)
    expect(noDriverStationName('x_akit_0123456789abcdef.wpilog')).toBe(false)
  })
  it('is worded with the count, the reason and the size', () => {
    expect(skippedWords(3, 41 * 2 ** 20)).toBe('Skipped 3 logs from power-ons with no Driver Station attached (the robot was never enabled), 41 MB.')
    expect(skippedWords(1, 1.4 * 2 ** 20)).toBe('Skipped 1 log from a power-on with no Driver Station attached (the robot was never enabled), 1.4 MB.')
  })
  it('counts megabytes as the phone\'s buttons do (2^20 bytes), through the one formatter', () => {
    for (const bytes of [0, 1_400_000, 9.99 * 2 ** 20, 10 * 2 ** 20, 41_000_000, 275 * 2 ** 20]) expect(sizeWords(bytes)).toBe(`${phoneMb(bytes)} MB`)
    expect(phoneMb).toBe(mb)
    expect(sizeWords(41_000_000)).toBe('39 MB') // 41 decimal MB is 39.1 MiB
  })
})

describe('a robot pull', () => {
  it('skips the hex-named logs by default, counts them with their bytes, and leaves everything else', async () => {
    const fs = fakeRobot([file(HEX, 10_000_000), file(HEX2, 31_000_000), file(DATED, 100), file('akit_0123456789abcdef.hoot', 50), file('notes.txt')])
    const { files, skipped } = await robotFiles(fs, await deps())
    expect(files.map((f) => f.name)).toEqual(['akit_0123456789abcdef.hoot', DATED])
    expect(skipped).toEqual([{ path: `${DIR}/${HEX}`, size: 10_000_000 }, { path: `${DIR}/${HEX2}`, size: 31_000_000 }])
    expect(fs.downloads).toEqual([])
  })

  it('pulls them too when asked, and reports none skipped', async () => {
    const { files, skipped } = await robotFiles(fakeRobot([file(HEX), file(DATED)]), { ...(await deps()), includeNoDriverStation: true })
    expect(files.map((f) => f.name).sort()).toEqual([DATED, HEX].sort())
    expect(skipped).toEqual([])
  })

  it('does not count a skipped file that is already in the library, and keeps it as a file ingest knows', async () => {
    const seen = new Map([[`robot:${DIR}/${HEX}|100|${NOW - 3600e3}`, 'a'.repeat(64)]])
    const { files, skipped } = await robotFiles(fakeRobot([file(HEX), file(HEX2)]), { ...(await deps()), seen })
    expect(skipped.map((s) => s.path)).toEqual([`${DIR}/${HEX2}`])
    expect(files.map((f) => f.name)).toEqual([HEX])
  })

  it('does not call a log still being written skipped', async () => {
    const { files, skipped, stillWriting } = await robotFiles(fakeRobot([file(HEX, 100, 5_000)]), await deps())
    expect(files).toEqual([])
    expect(skipped).toEqual([])
    expect(stillWriting).toEqual([`${DIR}/${HEX}`])
  })

  it('never marks a skipped file as seen, so a later forced pull still gets it', async () => {
    const bytes = robotLog({ clockMs: Date.UTC(2026, 9, 17), seed: 'hex one', neverEnabled: true }) // never enabled
    const lib = await LocalLibrary.open(await mkdtemp(join(tmpdir(), 'hindsight-skip-lib-')), 'machine-a')
    const seen = new Map<string, string>()
    const robot = fakeRobot([file(HEX, bytes.length)], { [`${DIR}/${HEX}`]: bytes })
    const pull = async (force: boolean) => {
      const listed = await robotFiles(robot, { ...(await deps()), seen, includeNoDriverStation: force })
      return { listed, report: await ingest(lib, listed.files, { describe: describeFile, seen }) }
    }
    const first = await pull(false)
    expect(first.listed.skipped).toHaveLength(1)
    expect(first.report.added).toEqual([])
    expect(seen.size).toBe(0)
    expect(robot.downloads).toEqual([])

    const forced = await pull(true)
    expect(forced.listed.skipped).toEqual([])
    expect(forced.report.added.map((e) => e.name)).toEqual([HEX])
    expect(robot.downloads).toEqual([`${DIR}/${HEX}`])
    expect(seen.size).toBe(1)

    // Once it is in the library the default pull no longer counts it.
    const again = await pull(false)
    expect(again.listed.skipped).toEqual([])
    expect(again.report.already.map((e) => e.name)).toEqual([HEX])
    expect(robot.downloads).toHaveLength(1)
  })
})
