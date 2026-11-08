/**
 * Sharing this laptop's own small files with the team as they change, so a phone (and teammates) see a mark or a new match
 * within seconds instead of at the next Sync:
 *  - its history file, about MARK_PUSH_DELAY_MS after the last mark (a burst of marks is one upload),
 *  - its event files (src/hub/event-file.ts), soon after the page appends lines for a newly added log,
 *  - and, every SHARE_EVERY_MS, anything still not up plus teammates' history files brought down.
 * Logs and manifests still wait for Sync (a log is ~50 MB, and the phone needs neither).
 *
 * The safety rule is Sync's: a push uploads only this laptop's own file and only when the team's copy is its start
 * (`appendManifest`); a teammate's copy here is replaced only by a longer one that starts with it. A pulled file is read from
 * the length already here, and the result is checked against Drive's md5; a mismatch means it was not just appended to, so
 * it is read whole. One Lock is taken around each of these and around Sync's history step, so they never interleave.
 *
 * Nothing runs until a sign-in is in use this run (`signInUsed`): the app never reads the Keychain at start-up
 * (electron/google-auth.ts), so the timers start only once a Drive action got a token. "Sign in again" stops them.
 * Not a job: the job runner runs one job at a time (jobs.ts), and a push must never block an import or a pull.
 */
import { ManifestConflict, SignInAgain, readText, type StorageAdapter } from './adapter.ts'

/** A burst of marks is one push: this long after the last one. */
export const MARK_PUSH_DELAY_MS = 10_000
/** An event file goes up this long after the page last appended to it (a folder of logs is one upload). */
export const EVENT_PUSH_DELAY_MS = 2_000
/** Retry what is not up, and bring teammates' history down. */
export const SHARE_EVERY_MS = 120_000

/** One holder at a time, in the order asked. */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work)
    this.tail = next.catch(() => {})
    return next
  }
}

export interface ShareStatus {
  /** The timers run (a sign-in is in use this run). */
  running: boolean
  /** Drive asked for a new sign-in: nothing is shared until there is one. */
  signInNeeded: boolean
  /** Lines of this laptop's own files not on the team Drive yet. */
  notUp: { marks: number; eventLines: number }
  /** When teammates' history was last brought down (ms), or null. */
  teammatesAsOf: number | null
  /** What went wrong last, in words, or null. */
  problem: string | null
}

export interface SharedLibrary {
  store: { list(prefix: string): Promise<{ path: string }[]>; stat(path: string): Promise<unknown>; read(path: string, start: number, end: number): Promise<Uint8Array>; appendManifest(path: string, content: string): Promise<void> }
  machine: string
  ownHistoryPath: string
}

export interface LiveShareOptions {
  lib: SharedLibrary
  /** The team folder's store, or null when none is chosen yet (then nothing is shared, quietly: the person may be choosing it). */
  team(): Promise<StorageAdapter | null>
  /** The lock Sync's history step takes too. */
  lock: Lock
  md5(text: string): string
  onHistoryChanged?(): void
  onStatus?(status: ShareStatus): void
  now?(): number
}

const lineCount = (text: string) => text.split('\n').filter((l) => l.trim() !== '').length
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class LiveShare {
  private readonly o: LiveShareOptions
  private running = false
  private signInNeeded = false
  private tick: ReturnType<typeof setInterval> | null = null
  private markTimer: ReturnType<typeof setTimeout> | null = null
  private eventTimer: ReturnType<typeof setTimeout> | null = null
  private eventKeys = new Set<string>()
  /** What the team's copy of each own file is known to hold (what was last pushed or found there). */
  private pushed = new Map<string, string>()
  private problems = new Map<string, string>()
  private teammatesAsOf: number | null = null

  constructor(options: LiveShareOptions) { this.o = options }

  /** A Drive action of this run got a token: start (once), and push what waited. */
  signInUsed(): void {
    if (this.running) return
    this.running = true
    this.signInNeeded = false
    this.problems.delete('sign-in')
    this.tick = setInterval(() => void this.everyTick(), SHARE_EVERY_MS)
    void this.everyTick()
  }

  /** Signed out, or Drive refused the sign-in: stop every timer until a sign-in is in use again. */
  stop(signInNeeded = false): void {
    this.running = false
    this.signInNeeded = signInNeeded
    for (const t of [this.markTimer, this.eventTimer]) if (t) clearTimeout(t)
    if (this.tick) clearInterval(this.tick)
    this.tick = this.markTimer = this.eventTimer = null
    void this.emit()
  }

  /** A mark was written to this laptop's history: push it after the burst. Before a sign-in it waits for the first tick. */
  noteMark(): void {
    if (!this.running) { void this.emit(); return }
    if (this.markTimer) clearTimeout(this.markTimer)
    this.markTimer = setTimeout(() => { this.markTimer = null; void this.guard(() => this.pushOwn(this.o.lib.ownHistoryPath)) }, MARK_PUSH_DELAY_MS)
  }

  /** The page appended lines to this laptop's file for an event. */
  noteEvent(key: string): void {
    this.eventKeys.add(key)
    if (!this.running) { void this.emit(); return }
    if (this.eventTimer) clearTimeout(this.eventTimer)
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null
      const keys = [...this.eventKeys]
      this.eventKeys.clear()
      void this.guard(async () => { for (const k of keys) await this.pushOwn(this.eventPath(k)) })
    }, EVENT_PUSH_DELAY_MS)
  }

  /** Another team folder was chosen: what the old one holds says nothing about the new one, so every own file is checked again. */
  teamChanged(): void {
    this.pushed.clear()
    this.problems.clear()
    if (this.running) void this.everyTick()
  }

  /** The window came to the front: bring teammates' marks down now (only while running). */
  async pullNow(): Promise<void> {
    if (this.running) await this.guard(() => this.pull())
  }

  async status(): Promise<ShareStatus> {
    const own = this.o.lib.ownHistoryPath
    const marks = Math.max(0, lineCount((await readText(this.o.lib.store as never, own)) ?? '') - lineCount(this.pushed.get(own) ?? ''))
    let eventLines = 0
    for (const path of await this.ownEventPaths()) eventLines += Math.max(0, lineCount((await readText(this.o.lib.store as never, path)) ?? '') - lineCount(this.pushed.get(path) ?? ''))
    const problem = [...this.problems.values()].join(' ')
    return { running: this.running, signInNeeded: this.signInNeeded, notUp: { marks, eventLines }, teammatesAsOf: this.teammatesAsOf, problem: problem || null }
  }

  private eventPath(key: string): string { return `events/${key}--${this.o.lib.machine}.jsonl` }

  private async ownEventPaths(): Promise<string[]> {
    const suffix = `--${this.o.lib.machine}.jsonl`
    return (await this.o.lib.store.list('events')).map((f) => f.path).filter((p) => p.endsWith(suffix))
  }

  private async everyTick(): Promise<void> {
    await this.guard(async () => {
      await this.pushOwn(this.o.lib.ownHistoryPath)
      for (const path of await this.ownEventPaths()) await this.pushOwn(path)
      await this.pull()
    })
  }

  /** Runs one piece of sharing: a lost sign-in stops everything; any other failure is said and tried again later. */
  private async guard(work: () => Promise<void>): Promise<void> {
    if (!this.running) return
    try { await work() } catch (e) {
      if (e instanceof SignInAgain) { this.problems.set('sign-in', 'Sign in to Google again to share marks and matches.'); this.stop(true); return }
      this.problems.set('drive', `Could not reach the team Drive (${e instanceof Error ? e.message : String(e)}); tried again in 2 min.`)
    }
    await this.emit()
  }

  private async emit(): Promise<void> {
    if (this.o.onStatus) this.o.onStatus(await this.status())
  }

  /** This laptop's own file up, when the team's copy is its start; a second push of the same content changes nothing. */
  private pushOwn(path: string): Promise<void> {
    return this.o.lock.run(async () => {
      const store = this.o.lib.store as never as StorageAdapter
      const local = (await readText(store, path)) ?? ''
      if (local === '' || local === this.pushed.get(path)) return
      const team = await this.o.team()
      if (!team) return
      const info = await team.stat(path)
      this.problems.delete('drive')
      if (info?.md5 && info.md5 === this.o.md5(local)) { this.pushed.set(path, local); return }
      const remote = info ? (await readText(team, path)) ?? '' : ''
      if (remote === local) { this.pushed.set(path, local); return }
      if (remote.length > local.length && remote.startsWith(local)) {
        // The team has more of this laptop's own file (a reinstall, a lost library): brought down, strictly additive, as Sync does.
        await this.o.lib.store.appendManifest(path, remote)
        this.pushed.set(path, remote)
        if (path === this.o.lib.ownHistoryPath) this.o.onHistoryChanged?.()
        return
      }
      try {
        await team.appendManifest(path, local)
        this.pushed.set(path, local)
        this.problems.delete(path)
      } catch (e) {
        if (!(e instanceof ManifestConflict)) throw e
        this.pushed.delete(path)
        this.problems.set(path, `The team Drive's ${path} differs from this copy (another install with this id?): not uploaded, nothing overwritten.`)
      }
    })
  }

  /** Teammates' history files down: only those whose md5 changed, from the length already here, checked against the md5. */
  private pull(): Promise<void> {
    return this.o.lock.run(async () => {
      const store = this.o.lib.store as never as StorageAdapter
      const team = await this.o.team()
      if (!team) return
      let changed = false
      for (const f of await team.list('history')) {
        if (!f.path.endsWith('.jsonl') || f.path === this.o.lib.ownHistoryPath) continue
        const mine = (await readText(store, f.path)) ?? ''
        if (f.md5 && f.md5 === this.o.md5(mine)) continue
        const have = encoder.encode(mine)
        let text: string | null = null
        if (have.length > 0 && f.md5 && f.size > have.length) {
          const tail = await team.read(f.path, have.length, f.size)
          const joined = new Uint8Array(have.length + tail.length)
          joined.set(have)
          joined.set(tail, have.length)
          const whole = decoder.decode(joined)
          if (this.o.md5(whole) === f.md5) text = whole
        }
        text ??= (await readText(team, f.path)) ?? ''
        if (text === mine) continue
        try {
          await this.o.lib.store.appendManifest(f.path, text)
          this.problems.delete(f.path)
          changed = true
        } catch (e) {
          if (!(e instanceof ManifestConflict)) throw e
          this.problems.set(f.path, `The team Drive's ${f.path} is shorter than, or differs from, the copy here: kept the copy here.`)
        }
      }
      this.problems.delete('drive')
      this.teammatesAsOf = (this.o.now ?? Date.now)()
      if (changed) this.o.onHistoryChanged?.()
    })
  }
}
