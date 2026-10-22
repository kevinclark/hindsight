/**
 * Pulling logs off the roboRIO. Read-only: the robot is asked to list and send files, nothing is written, moved or deleted
 * on it. Nothing runs on the robot (its own ssh server answers SFTP) and nothing is installed on the DS laptop.
 *
 *  - Only while the robot is disabled and not on the field (NT4, the same read-only client and field guard Foresight uses);
 *    when it can't tell, it refuses.
 *  - Paths: /home/lvuser/logs, /U/logs and /media/sd* (a USB stick appears under both of the last two: the same bytes are
 *    one log, so ingest files it once).
 *  - A file still being written is skipped: modified in the last 30 s, or growing between two listings.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Nt4Client, nt4Url, type SocketLike } from '../foresight/nt4-client.ts'
import { GUARD_CONTROL_DATA } from '../foresight/keys.ts'
import type { SourceFile } from './ingest.ts'
import { kindOf } from './types.ts'

export const ROBOT_LOG_ROOTS = ['/home/lvuser/logs', '/U/logs']
export const USB_PARENT = '/media'
export const RECENT_MS = 30_000
const MAX_DEPTH = 4

export interface RobotEntry { name: string; size: number; mtimeMs: number; isDir: boolean }

/** The robot's file system as the pull sees it: list a folder, copy one file to this machine. */
export interface RobotFs {
  list(dir: string): Promise<RobotEntry[]>
  download(remote: string, local: string): Promise<void>
  close(): void
}

export type Idle = { ok: true } | { ok: false; reason: string }

/** Whether the robot may be pulled from: connected, disabled, field not attached. Anything else, or not knowing, is a refusal. */
export function checkRobotIdle(address: string, options: { waitMs?: number; makeSocket?: (url: string, protocols: string[]) => SocketLike } = {}): Promise<Idle> {
  return new Promise((resolve) => {
    const waitMs = options.waitMs ?? 8000
    let settled = false
    let client: Nt4Client | null = null
    const finish = (r: Idle) => { if (settled) return; settled = true; clearTimeout(timer); client?.close(); resolve(r) }
    const timer = setTimeout(() => finish({ ok: false, reason: 'The robot did not say whether it is disabled and off the field, so nothing was pulled.' }), waitMs)
    try {
      client = new Nt4Client(nt4Url(address, 'hindsight-pull'), {
        onValues: (values) => {
          for (const v of values) {
            if (v.topic.name !== GUARD_CONTROL_DATA || typeof v.value !== 'number') continue
            if ((v.value & 1) !== 0) return finish({ ok: false, reason: 'The robot is enabled. Disable it before pulling logs.' })
            if (client?.guardClear) return finish({ ok: true })
          }
        },
        onField: () => finish({ ok: false, reason: 'The robot is on the field (FMS attached). Logs are not pulled on the field.' }),
        onClose: (reason) => finish({ ok: false, reason: `Could not check the robot: ${reason}` }),
      }, options.makeSocket)
      client.connect()
    } catch (e) { finish({ ok: false, reason: e instanceof Error ? e.message : String(e) }) }
  })
}

/** Every log on the robot that is finished being written, as ingest sources (a download happens only when ingest must read one). */
export async function robotFiles(fs: RobotFs, deps: { now?: () => number; sleep?: (ms: number) => Promise<void>; tempRoot?: string } = {}): Promise<SourceFile[]> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const walk = async (dir: string, depth: number, out: Map<string, RobotEntry>) => {
    let entries: RobotEntry[]
    try { entries = await fs.list(dir) } catch { return } // a folder that isn't there (no USB stick) is not an error
    for (const e of entries) {
      if (e.isDir) { if (depth < MAX_DEPTH) await walk(`${dir}/${e.name}`, depth + 1, out) } else if (kindOf(e.name)) out.set(`${dir}/${e.name}`, e)
    }
  }
  const scan = async () => {
    const found = new Map<string, RobotEntry>()
    for (const root of ROBOT_LOG_ROOTS) await walk(root, 0, found)
    const usb = await fs.list(USB_PARENT).catch(() => [] as RobotEntry[])
    for (const d of usb.filter((e) => e.isDir && /^sd/.test(e.name))) await walk(`${USB_PARENT}/${d.name}`, 0, found)
    return found
  }
  const first = await scan()
  await sleep(1500)
  const second = await scan()
  const out: SourceFile[] = []
  for (const [path, e] of second) {
    // Still being written: changed since the first listing, or modified in the last 30 s.
    if (first.get(path)?.size !== e.size || now() - e.mtimeMs < RECENT_MS) continue
    out.push({
      name: e.name, where: `robot:${path}`, size: e.size, modifiedTime: Math.round(e.mtimeMs), from: 'robot',
      open: async () => {
        const dir = await mkdtemp(join(deps.tempRoot ?? tmpdir(), 'hindsight-robot-'))
        const local = join(dir, e.name)
        try { await fs.download(path, local) } catch (err) { await rm(dir, { recursive: true, force: true }); throw err }
        return { path: local, done: () => rm(dir, { recursive: true, force: true }) }
      },
    })
  }
  return out.sort((a, b) => a.where.localeCompare(b.where))
}

/**
 * The roboRIO's own ssh server over SFTP (the `ssh2` package, as AdvantageScope does). The roboRIO's `lvuser` has an empty
 * password; this is not yet checked against a real roboRIO (live step 4).
 */
export async function connectRobotFs(address: string, timeoutMs = 10_000): Promise<RobotFs> {
  const { Client } = await import('ssh2')
  const ssh = new Client()
  await new Promise<void>((resolve, reject) => {
    ssh.once('ready', resolve).once('error', reject)
    ssh.connect({ host: address, username: 'lvuser', password: '', tryKeyboard: true, readyTimeout: timeoutMs })
    ssh.once('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([]))
  })
  // An error after the connection was made (the robot rebooted, Wi-Fi dropped) must not crash the app: the pending read fails on its own.
  ssh.on('error', () => {})
  const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => ssh.sftp((e, s) => (e ? reject(e) : resolve(s))))
  return {
    list: (dir) => new Promise((resolve, reject) => sftp.readdir(dir, (e, entries) => (e ? reject(e) : resolve(entries.map((x) => ({ name: x.filename, size: x.attrs.size, mtimeMs: x.attrs.mtime * 1000, isDir: x.attrs.isDirectory() })))))),
    download: (remote, local) => new Promise((resolve, reject) => {
      const read = sftp.createReadStream(remote)
      const write = createWriteStream(local)
      read.on('error', reject); write.on('error', reject); write.on('close', () => resolve())
      read.pipe(write)
    }),
    close: () => ssh.end(),
  }
}
