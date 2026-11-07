// The robot pull: the idle check against a replayed robot, and the file listing against a fake robot file system.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRobotIdle, robotFiles, type RobotEntry, type RobotFs } from '../src/hub/robot.ts'
import { ingest } from '../src/hub/ingest.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { describeFile } from '../src/hub/describe-file.ts'
import { resetFieldLockForTests } from '../src/foresight/nt4-client.ts'
import { startReplayServer, type ReplayServer } from './helpers/nt4-replay-server.ts'
import { robotLog } from './helpers/hub-logs.ts'

let server: ReplayServer | null = null
afterEach(async () => { await server?.close(); server = null; resetFieldLockForTests() })

const log = (o: Parameters<typeof robotLog>[0]) => robotLog({ enabled: [2, 4], clockMs: Date.UTC(2026, 9, 17), ...o })

describe('is the robot idle?', () => {
  const check = (startAt: number, o: Parameters<typeof robotLog>[0] = {}, pit = true) => startReplayServer({ bytes: log(o), startAt, pit, speed: 1 }).then((s) => { server = s; return checkRobotIdle(`127.0.0.1:${s.port}`, { waitMs: 3000 }) })

  it('says yes for a disabled robot in the pit', async () => {
    expect(await check(0)).toEqual({ ok: true })
  })
  it('refuses an enabled robot', async () => {
    const r = await check(3)
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/enabled/) })
  })
  it('refuses a robot on the field', async () => {
    const r = await check(0, { fms: true }, false)
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/field/) })
  })
  it('refuses when nothing answers, rather than guessing', async () => {
    const r = await checkRobotIdle('127.0.0.1:1', { waitMs: 1500 })
    expect(r.ok).toBe(false)
  })
  // A socket that never opens (a robot that is off or not cabled) is "not reached"; one that opens and then says nothing was reached.
  const fakeSocket = (open: boolean) => () => {
    const s = { binaryType: '', readyState: 0, onopen: null as ((e: unknown) => void) | null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }
    if (open) setTimeout(() => s.onopen?.({}), 10)
    return s
  }
  it('words a socket that never opened as not reached, and one that opened as reached', async () => {
    const never = await checkRobotIdle('10.0.0.2', { waitMs: 200, makeSocket: fakeSocket(false) })
    expect(never).toMatchObject({ ok: false, reason: expect.stringMatching(/^Could not reach the robot: nothing answered at 10\.0\.0\.2/) })
    const silent = await checkRobotIdle('10.0.0.2', { waitMs: 200, makeSocket: fakeSocket(true) })
    expect(silent).toMatchObject({ ok: false, reason: expect.stringMatching(/^The robot did not say whether/) })
  })
})

describe('what is on the robot', () => {
  const NOW = Date.UTC(2026, 9, 17, 20)
  /** A robot whose files hold `contents[path]` (else `bytes of <path>`); `cut` sends a file short by that many bytes. */
  function fakeRobot(tree: Record<string, RobotEntry[]>, grow: Record<string, number> = {}, contents: Record<string, Uint8Array> = {}, cut: Record<string, number> = {}): RobotFs & { listings: number; downloads: string[] } {
    let pass = 0
    const fs = {
      listings: 0, downloads: [] as string[],
      async list(dir: string) {
        if (dir === '/home/lvuser/logs') pass++
        if (!(dir in tree)) throw new Error('no such folder')
        return tree[dir].map((e) => ({ ...e, size: e.size + (pass > 1 ? grow[e.name] ?? 0 : 0) }))
      },
      async download(remote: string, local: string) {
        fs.downloads.push(remote)
        const bytes = contents[remote] ?? Buffer.from(`bytes of ${remote}`)
        await writeFile(local, bytes.subarray(0, bytes.length - (cut[remote] ?? 0)))
      },
      close() {},
    }
    return fs
  }
  const file = (name: string, size = 100, age = 3600e3): RobotEntry => ({ name, size, mtimeMs: NOW - age, isDir: false })
  const dir = (name: string): RobotEntry => ({ name, size: 0, mtimeMs: 0, isDir: true })

  it('lists logs under the three places, skips what is still being written, and ignores other files', async () => {
    const fs = fakeRobot({
      '/home/lvuser/logs': [file('a.wpilog'), file('fresh.wpilog', 100, 5_000), file('growing.wpilog'), file('b.hoot'), file('notes.txt'), dir('old')],
      '/home/lvuser/logs/old': [file('c.wpilog')],
      '/U/logs': [file('d.wpilog')],
      '/media': [dir('sda1'), dir('other')],
      '/media/sda1': [dir('logs')],
      '/media/sda1/logs': [file('e.dslog')],
    }, { 'growing.wpilog': 50 })
    const { files, stillWriting } = await robotFiles(fs, { now: () => NOW, sleep: async () => {} })
    expect(files.map((f) => f.where)).toEqual([
      'robot:/home/lvuser/logs/a.wpilog', 'robot:/home/lvuser/logs/b.hoot', 'robot:/home/lvuser/logs/old/c.wpilog', 'robot:/media/sda1/logs/e.dslog', 'robot:/U/logs/d.wpilog',
    ])
    expect(files[0]).toMatchObject({ from: 'robot', modifiedTime: NOW - 3600e3, size: 100 })
    expect(stillWriting).toEqual(['/home/lvuser/logs/fresh.wpilog', '/home/lvuser/logs/growing.wpilog'])
    expect(fs.downloads).toEqual([]) // listing downloads nothing
  })

  it('skips a file whose time is ahead of this computer\'s clock too, and says so', async () => {
    const fs = fakeRobot({ '/home/lvuser/logs': [file('ahead.wpilog', 100, -20_000)] })
    const { files, stillWriting } = await robotFiles(fs, { now: () => NOW, sleep: async () => {} })
    expect(files).toEqual([])
    expect(stillWriting).toEqual(['/home/lvuser/logs/ahead.wpilog'])
  })

  it('downloads a file to a temp folder only when opened, and removes it when done', async () => {
    const fs = fakeRobot({ '/home/lvuser/logs': [file('a.wpilog', 'bytes of /home/lvuser/logs/a.wpilog'.length)] })
    const { files: [f] } = await robotFiles(fs, { now: () => NOW, sleep: async () => {}, tempRoot: await mkdtemp(join(tmpdir(), 'hindsight-robot-test-')) })
    const opened = await f.open()
    expect(await readFile(opened.path, 'utf8')).toBe('bytes of /home/lvuser/logs/a.wpilog')
    await opened.done()
    await expect(readFile(opened.path)).rejects.toThrow()
    await rm(join(opened.path, '..', '..'), { recursive: true, force: true })
  })

  // The pull ran every log through ingest each time, downloading all of it to hash it (2026-11-07). A log pulled before is now known
  // by its path, size and modified time, as a local folder's file is, and only new or changed logs are downloaded.
  describe('pulling again', () => {
    const tempRoot = () => mkdtemp(join(tmpdir(), 'hindsight-robot-test-'))
    const bytesA = robotLog({ clockMs: Date.UTC(2026, 9, 17), enabled: [2, 4], seed: 'pull a' })
    const bytesB = robotLog({ clockMs: Date.UTC(2026, 9, 17), enabled: [2, 4], seed: 'pull b' })
    const A = '/home/lvuser/logs/a.wpilog', B = '/home/lvuser/logs/b.wpilog'

    it('downloads only the logs it has not pulled before', async () => {
      const lib = await LocalLibrary.open(await tempRoot(), 'machine-a')
      const seen = new Map<string, string>()
      const pull = async (fs: RobotFs) => ingest(lib, (await robotFiles(fs, { now: () => NOW, sleep: async () => {}, tempRoot: await tempRoot() })).files, { describe: describeFile, seen })

      const one = fakeRobot({ '/home/lvuser/logs': [file('a.wpilog', bytesA.length)] }, {}, { [A]: bytesA })
      expect((await pull(one)).added.map((e) => e.name)).toEqual(['a.wpilog'])
      expect(one.downloads).toEqual([A])

      // The next pull: a.wpilog unchanged, b.wpilog new. Only b is downloaded; a is reported as already in the library.
      const two = fakeRobot({ '/home/lvuser/logs': [file('a.wpilog', bytesA.length), file('b.wpilog', bytesB.length)] }, {}, { [A]: bytesA, [B]: bytesB })
      const report = await pull(two)
      expect(two.downloads).toEqual([B])
      expect(report.added.map((e) => e.name)).toEqual(['b.wpilog'])
      expect(report.already.map((e) => e.name)).toEqual(['a.wpilog'])

      // The same path with a different size or modified time is a different file: read again.
      const three = fakeRobot({ '/home/lvuser/logs': [file('a.wpilog', bytesA.length, 7200e3)] }, {}, { [A]: bytesA })
      await pull(three)
      expect(three.downloads).toEqual([A])
    })

    it('files nothing and remembers nothing from a download cut short', async () => {
      const lib = await LocalLibrary.open(await tempRoot(), 'machine-a')
      const seen = new Map<string, string>()
      const tree = { '/home/lvuser/logs': [file('a.wpilog', bytesA.length)] }
      const short = fakeRobot(tree, {}, { [A]: bytesA }, { [A]: 100 })
      const report = await ingest(lib, (await robotFiles(short, { now: () => NOW, sleep: async () => {}, tempRoot: await tempRoot() })).files, { describe: describeFile, seen })
      expect(report.unreadable[0].reason).toMatch(/download stopped at \d+ of \d+ bytes/)
      expect(report.added).toEqual([])
      expect(seen.size).toBe(0)
      // The next pull reads it in full.
      const whole = fakeRobot(tree, {}, { [A]: bytesA })
      const again = await ingest(lib, (await robotFiles(whole, { now: () => NOW, sleep: async () => {}, tempRoot: await tempRoot() })).files, { describe: describeFile, seen })
      expect(again.added.map((e) => e.name)).toEqual(['a.wpilog'])
    })
  })
})
