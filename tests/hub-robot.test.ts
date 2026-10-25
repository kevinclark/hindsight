// The robot pull: the idle check against a replayed robot, and the file listing against a fake robot file system.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRobotIdle, robotFiles, type RobotEntry, type RobotFs } from '../src/hub/robot.ts'
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
  function fakeRobot(tree: Record<string, RobotEntry[]>, grow: Record<string, number> = {}): RobotFs & { listings: number; downloads: string[] } {
    let pass = 0
    const fs = {
      listings: 0, downloads: [] as string[],
      async list(dir: string) {
        if (dir === '/home/lvuser/logs') pass++
        if (!(dir in tree)) throw new Error('no such folder')
        return tree[dir].map((e) => ({ ...e, size: e.size + (pass > 1 ? grow[e.name] ?? 0 : 0) }))
      },
      async download(remote: string, local: string) { fs.downloads.push(remote); await writeFile(local, `bytes of ${remote}`) },
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
    const fs = fakeRobot({ '/home/lvuser/logs': [file('a.wpilog')] })
    const { files: [f] } = await robotFiles(fs, { now: () => NOW, sleep: async () => {}, tempRoot: await mkdtemp(join(tmpdir(), 'hindsight-robot-test-')) })
    const opened = await f.open()
    expect(await readFile(opened.path, 'utf8')).toBe('bytes of /home/lvuser/logs/a.wpilog')
    await opened.done()
    await expect(readFile(opened.path)).rejects.toThrow()
    await rm(join(opened.path, '..', '..'), { recursive: true, force: true })
  })
})
