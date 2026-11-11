/**
 * Pulling logs off the roboRIO. Read-only: the robot is asked to list and send files, nothing is written, moved or deleted
 * on it. Nothing runs on the robot (its own ssh server answers SFTP) and nothing is installed on the DS laptop.
 *
 *  - Only while the robot is disabled and not on the field (NT4, the same read-only client and field guard Foresight uses);
 *    when it can't tell, it refuses.
 *  - Paths: /home/lvuser/logs, /U/logs and /media/sd* (a USB stick appears under both of the last two: the same bytes are
 *    one log, so ingest files it once).
 *  - A file still being written is skipped: modified in the last 30 s, or growing between two listings.
 *  - A log pulled before (same path, size and modified time) is not downloaded again.
 *  - A log from a power-on with no Driver Station (AdvantageKit's `akit_<16 hex digits>.wpilog`, ADR 15) is left on the robot
 *    unless the pull is told to include it; the pull says how many it left, and a skipped file is never marked seen.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Nt4Client, isFieldLocked, nt4Url, type SocketLike } from '../foresight/nt4-client.ts'
import { GUARD_CONTROL_DATA } from '../foresight/keys.ts'
import { LinkLost, Stopped } from './adapter.ts'
import { STALL_MS, Stalled, TRIES, atWords, secsWords, watchdog } from './transfer-watch.ts'
import type { SourceFile, Watch } from './ingest.ts'
import { kindOf } from './types.ts'
export { notReached } from './robot-reach.ts'
export { skippedWords } from './skip-words.ts'
export { STALL_MS, Stalled, TRIES }

export const ROBOT_LOG_ROOTS = ['/home/lvuser/logs', '/U/logs']
export const USB_PARENT = '/media'
export const RECENT_MS = 30_000
/** The roboRIO answers ssh keepalives; three missed, 5 s apart, and a dead link is noticed in about 15 s. */
export const KEEPALIVE = { keepaliveInterval: 5000, keepaliveCountMax: 3 } as const
export const CONNECT_MS = 10_000
const MAX_DEPTH = 4

export interface RobotEntry { name: string; size: number; mtimeMs: number; isDir: boolean }

/** The robot's file system as the pull sees it: list a folder, copy one file to this machine. */
export interface RobotFs {
  /** `cancelled` turning true rejects with Stopped promptly, even while the robot holds the answer. */
  list(dir: string, cancelled?: () => boolean): Promise<RobotEntry[]>
  /**
   * Copy one file here, reporting bytes as they arrive; throws Stopped as soon as `watch.cancelled` says so. A link that goes
   * quiet or drops is reconnected and the file resumed from the bytes already written, up to TRIES in all; then LinkLost.
   * `size` (the listing's) is only for the words of a stall.
   */
  download(remote: string, local: string, watch?: Watch, size?: number): Promise<void>
  close(): void
}

export type Idle = { ok: true } | { ok: false; reason: string }

/** Whether the robot may be pulled from: connected, disabled, field not attached. Anything else, or not knowing, is a refusal. */
export function checkRobotIdle(address: string, options: { waitMs?: number; makeSocket?: (url: string, protocols: string[]) => SocketLike } = {}): Promise<Idle> {
  // The field guard locks for the rest of the run (Foresight's rule): say so, rather than wait and time out.
  if (isFieldLocked()) return Promise.resolve({ ok: false, reason: 'This robot was on the field earlier in this run. Restart Hindsight before pulling logs in the pit.' })
  return new Promise((resolve) => {
    const waitMs = options.waitMs ?? 8000
    let settled = false
    let client: Nt4Client | null = null
    // Whether the robot's NT4 socket ever opened: before it does, nothing has answered (a robot that is off or not cabled
    // usually never opens the socket at all, so the wait runs out); after it does, the robot was reached.
    let opened = false
    const finish = (r: Idle) => { if (settled) return; settled = true; clearTimeout(timer); client?.close(); resolve(r) }
    const timer = setTimeout(() => finish({ ok: false, reason: opened
      ? 'The robot did not say whether it is disabled and off the field, so nothing was pulled.'
      : `Could not reach the robot: nothing answered at ${address} within ${Math.round(waitMs / 1000)} s.` }), waitMs)
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
        onOpen: () => { opened = true },
        onClose: (reason) => finish({ ok: false, reason: `${opened ? 'Could not check the robot' : 'Could not reach the robot'}: ${reason}` }),
      }, options.makeSocket)
      client.connect()
    } catch (e) { finish({ ok: false, reason: e instanceof Error ? e.message : String(e) }) }
  })
}

/**
 * AdvantageKit names a log `akit_<random hex>.wpilog` and renames it to a timestamp only once the Driver Station is attached
 * and the clock valid for 5 s; a robot can't be enabled without a Driver Station, so a file still named so never was (ADR 15).
 */
export const noDriverStationName = (name: string): boolean => /^akit_[0-9a-f]{16}\.wpilog$/.test(name)

/** Files a pull left on the robot because they are from a power-on with no Driver Station. */
export interface SkippedFile { path: string; size: number }

/**
 * Every log on the robot that is finished being written, as ingest sources (a download happens only when ingest must read one: never for a log seen before).
 * `includeNoDriverStation` pulls the hex-named logs too. `seen` (the pull's memory) tells which of them are already in the library:
 * those stay in `files` (ingest says "already", downloading nothing) and are not counted as skipped.
 */
export async function robotFiles(fs: RobotFs, deps: { now?: () => number; sleep?: (ms: number) => Promise<void>; tempRoot?: string; cancelled?: () => boolean; includeNoDriverStation?: boolean; seen?: { get(key: string): string | undefined } } = {}): Promise<{ files: SourceFile[]; stillWriting: string[]; skipped: SkippedFile[] }> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const walk = async (dir: string, depth: number, out: Map<string, RobotEntry>) => {
    let entries: RobotEntry[]
    try { entries = await fs.list(dir, deps.cancelled) } catch (e) { if (e instanceof Stalled || e instanceof Stopped) throw e; return } // a folder that isn't there (no USB stick) is not an error; a robot that stopped answering is
    for (const e of entries) {
      if (e.isDir) { if (depth < MAX_DEPTH) await walk(`${dir}/${e.name}`, depth + 1, out) } else if (kindOf(e.name)) out.set(`${dir}/${e.name}`, e)
    }
  }
  const scan = async () => {
    const found = new Map<string, RobotEntry>()
    for (const root of ROBOT_LOG_ROOTS) await walk(root, 0, found)
    const usb = await fs.list(USB_PARENT, deps.cancelled).catch((e) => { if (e instanceof Stalled || e instanceof Stopped) throw e; return [] as RobotEntry[] })
    for (const d of usb.filter((e) => e.isDir && /^sd/.test(e.name))) await walk(`${USB_PARENT}/${d.name}`, 0, found)
    return found
  }
  const first = await scan()
  await sleep(1500)
  const second = await scan()
  const out: SourceFile[] = []
  const stillWriting: string[] = []
  const skipped: SkippedFile[] = []
  for (const [path, e] of second) {
    // Still being written: changed since the first listing, or modified within 30 s of now by either clock (the robot's clock comes from the DS laptop and can be ahead of this one).
    if (first.get(path)?.size !== e.size || Math.abs(now() - e.mtimeMs) < RECENT_MS) { stillWriting.push(path); continue }
    const cacheKey = `robot:${path}|${e.size}|${Math.round(e.mtimeMs)}`
    // Left on the robot, and never offered to ingest, so never put in the seen memory: a later forced pull still gets it.
    if (!deps.includeNoDriverStation && noDriverStationName(e.name) && deps.seen?.get(cacheKey) === undefined) { skipped.push({ path, size: e.size }); continue }
    out.push({
      name: e.name, where: `robot:${path}`, size: e.size, modifiedTime: Math.round(e.mtimeMs), from: 'robot',
      // A finished log seen before with the same path, size and modified time is not downloaded again (ingest's "seen" memory).
      cacheKey,
      open: async (watch) => {
        const dir = await mkdtemp(join(deps.tempRoot ?? tmpdir(), 'hindsight-robot-'))
        const local = join(dir, e.name)
        try {
          await fs.download(path, local, { cancelled: watch?.cancelled, onProgress: (sent) => watch?.onProgress?.(sent, e.size), onStep: watch?.onStep, log: watch?.log }, e.size)
          // A copy cut short (the link dropped) must not be filed, nor remembered under this file's key as its content.
          const got = (await stat(local)).size
          if (got !== e.size) throw new Error(`the download stopped at ${got} of ${e.size} bytes; pull again`)
        } catch (err) { await rm(dir, { recursive: true, force: true }); throw err }
        return { path: local, done: () => rm(dir, { recursive: true, force: true }) }
      },
    })
  }
  return { files: out.sort((a, b) => a.where.localeCompare(b.where)), stillWriting, skipped: skipped.sort((a, b) => a.path.localeCompare(b.path)) }
}

/** `host` or `host:port` (the port is for a test server; the robot's is 22). */
export function parseAddress(address: string): { host: string; port: number } {
  const m = /^(.+):(\d+)$/.exec(address)
  return m ? { host: m[1], port: Number(m[2]) } : { host: address, port: 22 }
}

export interface RobotOptions {
  /** No data for this long is a stall (default STALL_MS). */
  stallMs?: number
  connectMs?: number
  tries?: number
  /** Lines for the job log (stalls, reconnects, resumes); a download's own `watch.log` wins. */
  log?: (line: string) => void
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The roboRIO's own ssh server over SFTP (the `ssh2` package, as AdvantageScope does). The roboRIO's `lvuser` has an empty
 * password; this is not yet checked against a real roboRIO (live step 4). Never silent: ssh keepalives are on, a download or
 * listing that gets nothing for `stallMs` fails with the words, and a file is reconnected and resumed rather than started over.
 */
export async function connectRobotFs(address: string, options: RobotOptions = {}): Promise<RobotFs> {
  const { Client } = await import('ssh2')
  const stallMs = options.stallMs ?? STALL_MS
  const connectMs = options.connectMs ?? CONNECT_MS
  const tries = options.tries ?? TRIES
  const { host, port } = parseAddress(address)

  interface Conn { ssh: InstanceType<typeof Client>; sftp: import('ssh2').SFTPWrapper | null; dead: string | null; watchers: Set<(why: string) => void> }
  const open = (): Promise<Conn> => new Promise<Conn>((resolve, reject) => {
    const ssh = new Client()
    const conn: Conn = { ssh, sftp: null, dead: null, watchers: new Set() }
    const die = (why: string) => { if (conn.dead) return; conn.dead = why; for (const w of [...conn.watchers]) w(why) }
    let settled = false
    const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); ssh.destroy(); reject(e) }
    const timer = setTimeout(() => fail(new Error(`could not connect to the robot within ${secsWords(connectMs)}`)), connectMs)
    // An error after the connection was made (the robot rebooted, Wi-Fi dropped) must not crash the app: the pending read fails on its own.
    ssh.on('error', (e) => { die(e.message); fail(e) })
    ssh.on('close', () => { die('the connection to the robot closed'); fail(new Error('the connection to the robot closed')) })
    ssh.once('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([]))
    ssh.once('ready', () => {
      ssh.sftp((e, sftp) => {
        if (e) return fail(e)
        if (settled) return
        settled = true
        clearTimeout(timer)
        conn.sftp = sftp
        resolve(conn)
      })
    })
    try { ssh.connect({ host, port, username: 'lvuser', password: '', tryKeyboard: true, readyTimeout: connectMs + 2000, ...KEEPALIVE }) } catch (e) { fail(e as Error) }
  })

  let conn = await open()
  const note = (watch: Watch | undefined, line: string) => (watch?.log ?? options.log)?.(line)

  /** A new connection, abandoned (and closed when it arrives) if Stop is pressed meanwhile. */
  const reconnect = (watch: Watch): Promise<void> => new Promise<void>((resolve, reject) => {
    conn.ssh.destroy()
    let stopped = false
    const poll = setInterval(() => { if (watch.cancelled?.()) { stopped = true; clearInterval(poll); reject(new Stopped()) } }, 100)
    open().then((c) => { clearInterval(poll); if (stopped) c.ssh.destroy(); else { conn = c; resolve() } }, (e) => { clearInterval(poll); if (!stopped) reject(e) })
  })

  /** One go at the file from byte `start`: resolves when the stream ended and the local file is closed. */
  const transfer = (remote: string, local: string, start: number, watch: Watch, size: number | undefined, high: { v: number }) => new Promise<void>((resolve, reject) => {
    const c = conn
    if (c.dead || !c.sftp) return reject(new Stalled(`the connection to the robot closed (${c.dead ?? 'not open'}), ${atWords(start, size)}`))
    const read = c.sftp.createReadStream(remote, start > 0 ? { start } : undefined)
    const write = createWriteStream(local, { flags: start > 0 ? 'a' : 'w' })
    let got = start
    // Bytes are reported only past what an earlier try already reported, so the bar never dips and the step words ("Reconnected; resuming") stay until new bytes arrive.
    let failure: Error | null = null
    let stopped = false
    const teardown = () => { read.destroy(); write.destroy() }
    const fail = (e: Error) => { if (failure || stopped) return; failure = e; dog.done(); teardown() }
    // Stop is looked for on every piece and a few times a second, so a link that stalls mid-file still stops.
    const dog = watchdog({ stallMs, cancelled: watch.cancelled, onStop: () => { if (!failure) { stopped = true; teardown() } }, onStall: () => fail(new Stalled(`no data from the robot for ${secsWords(stallMs)}, ${atWords(got, size)}`)) })
    const onDead = (why: string) => fail(new Stalled(`the connection to the robot closed (${why}), ${atWords(got, size)}`))
    c.watchers.add(onDead)
    read.on('data', (chunk: Buffer) => {
      dog.alive()
      if (stopped || failure) return
      got += chunk.length
      if (got > high.v) { high.v = got; watch.onProgress?.(got, 0) } // the total is the listing's size, which the caller has
    })
    write.on('drain', () => dog.alive())
    // A refused or missing file is not a bad link (SFTP status 2, 3): it fails this file as it always did.
    read.on('error', (e: Error & { code?: unknown }) => fail(e.code === 2 || e.code === 3 ? Object.assign(e, { permanent: true }) : new Stalled(`${msg(e)}, ${atWords(got, size)}`)))
    write.on('error', (e) => fail(Object.assign(e, { permanent: true })))
    // Settled only once the file is closed, so the caller can remove it (Windows keeps a folder with an open file in it).
    write.on('close', () => {
      dog.done()
      c.watchers.delete(onDead)
      if (stopped) reject(new Stopped()); else if (failure) reject(failure); else resolve()
    })
    read.pipe(write)
  })

  return {
    list: (dir, cancelled) => new Promise((resolve, reject) => {
      if (cancelled?.()) return reject(new Stopped())
      const c = conn
      if (c.dead || !c.sftp) return reject(new Stalled(`the connection to the robot closed (${c.dead ?? 'not open'}) before listing ${dir}`))
      const cleanup = () => { dog.done(); c.watchers.delete(onDead) }
      const dog = watchdog({ stallMs, cancelled, onStop: () => { cleanup(); reject(new Stopped()) }, onStall: () => { cleanup(); reject(new Stalled(`no answer from the robot for ${secsWords(stallMs)} listing ${dir}`)) } })
      const onDead = (why: string) => { cleanup(); reject(new Stalled(`the connection to the robot closed (${why}) while listing ${dir}`)) }
      c.watchers.add(onDead)
      c.sftp.readdir(dir, (e, entries) => { cleanup(); if (e) reject(e); else resolve(entries.map((x) => ({ name: x.filename, size: x.attrs.size, mtimeMs: x.attrs.mtime * 1000, isDir: x.attrs.isDirectory() }))) })
    }),
    download: async (remote, local, watch = {}, size) => {
      let last = ''
      let lastCause: unknown
      const high = { v: 0 }
      for (let attempt = 1; attempt <= tries; attempt++) {
        if (watch.cancelled?.()) throw new Stopped()
        // What is already written is the start of the file on the robot: carry on from there, never from 0.
        const have = attempt === 1 ? 0 : (await stat(local).catch(() => null))?.size ?? 0
        if (attempt > 1 || conn.dead) {
          const words = attempt > 1 ? `Robot stopped sending; reconnecting (try ${attempt} of ${tries})` : 'Reconnecting to the robot'
          watch.onStep?.(words)
          try { await reconnect(watch) } catch (e) {
            if (e instanceof Stopped) throw e
            last = `could not reconnect to the robot: ${msg(e)}`
            lastCause = e
            note(watch, `reconnect failed (try ${attempt} of ${tries}): ${msg(e)}`)
            continue
          }
          note(watch, `reconnected; resume ${remote} at offset ${have}`)
          watch.onStep?.(`Reconnected; resuming ${atWords(have)} (try ${attempt} of ${tries})`)
        }
        try { await transfer(remote, local, have, watch, size, high); return } catch (e) {
          if (e instanceof Stopped || (e as { permanent?: boolean }).permanent) throw e
          last = msg(e)
          lastCause = e
          note(watch, `${e instanceof Stalled && /^no data/.test(last) ? 'stall' : 'link lost'} (try ${attempt} of ${tries}): ${last}`)
        }
      }
      throw new LinkLost(`${last}; tried ${tries} time${tries === 1 ? '' : 's'}`, lastCause)
    },
    close: () => { const c = conn; c.ssh.end(); setTimeout(() => c.ssh.destroy(), 1000).unref() },
  }
}
