/**
 * The app's updater: owns the one `UpdateState` (src/hub/update-state.ts), feeds it what the update source says, tells the
 * window each new state and writes the notable ones to the job log. Installed Windows, Linux and signed Mac builds use
 * electron-updater (it downloads in the background and installs on quit); an unsigned Mac build can't, so it asks the public
 * repo's releases and the chip offers the download link. Never restarts by itself: only `restart()`, which the user asks for.
 * Everything Electron is reached through `UpdaterEnv`, so tests drive it with fakes (tests/updater.test.ts).
 */
import type { App, AutoUpdater as NativeUpdater } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { selfUpdates, checkForUpdate } from '../src/hub/update.ts'
import { CHECK_EVERY_MS, STALL_ABORT_MS, STALL_MS, initial, step, type UpdateEvent, type UpdateState } from '../src/hub/update-state.ts'

/** A check (or GitHub request) with no answer in this long is reported as failed, so the chip never sits on "checking…". */
export const CHECK_TIMEOUT_MS = 60_000
/** How often the stall watch looks; a gap much longer than this means the computer slept. */
export const TICK_MS = 5_000

/** The part of electron-updater's autoUpdater this file uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  forceDevUpdateConfig?: boolean
  updateConfigPath?: string | null
  on(event: string, listener: (arg: any) => void): unknown
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; cancellationToken?: { cancel(): void }; downloadPromise?: Promise<unknown> | null } | null>
  downloadUpdate(cancellationToken?: { cancel(): void }): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** What the updater needs from Electron and the build. */
export interface UpdaterEnv {
  version: string
  packaged: boolean
  platform: string
  macSigned: boolean
  userData: string
  /** Dev-only hooks, honoured only when not packaged: a local feed URL, and a frozen state (JSON) for screenshots. */
  feed?: string
  forced?: string
  loadAutoUpdater(): Promise<AutoUpdaterLike>
  /** Squirrel.Mac's own updater (Electron's `autoUpdater`) on darwin: it says when the update is really staged. */
  nativeUpdater: { on(event: string, listener: (arg: any) => void): unknown } | null
  checkForUpdate: typeof checkForUpdate
}

export interface UpdaterDeps {
  /** The job log's `line` (the same instance hub-ipc's jobs write to). Byte progress is never written. */
  log: (line: string) => void
  /** Tell the window the new state. */
  send: (state: UpdateState) => void
  /** The name of a job running now (any runner), or null. */
  runningJob: () => string | null
  now?: () => number
}

/** The answer to Restart now. `started`: the app is quitting to install. */
export interface RestartAnswer { busy?: string; preparing?: boolean; started?: boolean }

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200) || 'unknown error'

/** The real environment, from the Electron modules hub-ipc already imports (so nothing here can fail to load). */
export function electronEnv(app: App, native: NativeUpdater): UpdaterEnv {
  return {
    version: app.getVersion(), packaged: app.isPackaged, platform: process.platform,
    macSigned: typeof __MAC_SIGNED__ === 'boolean' && __MAC_SIGNED__, userData: app.getPath('userData'),
    feed: process.env.HINDSIGHT_UPDATE_FEED, forced: process.env.HINDSIGHT_UPDATE_STATE,
    // autoUpdater is a lazy getter Node can't see as a named export of the CommonJS module: read it off the default.
    loadAutoUpdater: () => import('electron-updater').then((m) => (m.default ?? m).autoUpdater as unknown as AutoUpdaterLike),
    nativeUpdater: process.platform === 'darwin' ? native : null,
    checkForUpdate,
  }
}

export class Updater {
  private state: UpdateState
  private readonly selfUpdating: boolean
  private readonly now: () => number
  private checking = false
  private frozen = false
  private auto: Promise<AutoUpdaterLike> | null = null
  /** Cancels the download in flight (electron-updater's token from the check that started it). */
  private cancelDownload: (() => void) | null = null
  /** Set when we gave up a stalled download, so electron-updater's own 'cancelled' error doesn't replace our reason. */
  private gaveUp = false
  /** The download promise of the last download started, until it settles. */
  private inFlight: Promise<unknown> | null = null
  /**
   * A cancelled download that hasn't ended yet. electron-updater joins a new download to one still in flight (AppUpdater.js
   * 442), and on the differential path a cancel is seen only when the next chunk arrives: no check until it has ended.
   */
  private stopping = false
  /** When the stop began: a cancelled download that never ends (a dead link with no chunk to notice the cancel) stops blocking checks after STALL_ABORT_MS. */
  private stoppingSince = 0
  /** darwin: Squirrel has staged the downloaded update (electron-updater says 'downloaded' before Squirrel has it). */
  private staged = false
  private lastTick: number
  private awakeAt = 0
  private readonly feed: string | undefined

  private readonly env: UpdaterEnv
  private readonly deps: UpdaterDeps

  constructor(env: UpdaterEnv, deps: UpdaterDeps) {
    this.env = env
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.lastTick = this.now()
    // Dev-only test hook: a local server stands in for the release feed, so real electron-updater events can be exercised.
    this.feed = !env.packaged ? env.feed : undefined
    this.selfUpdating = !!this.feed || selfUpdates({ isPackaged: env.packaged, platform: env.platform, macSigned: env.macSigned })
    this.state = initial(env.version, this.selfUpdating, env.packaged)
    // Dev-only test hook for screenshots: start in the given state and run no checks.
    const forced = !env.packaged ? env.forced : undefined
    if (forced) {
      try { this.state = JSON.parse(forced) as UpdateState; this.frozen = true } catch { /* not JSON: ignored, the run checks as usual */ }
    }
    env.nativeUpdater?.on('update-downloaded', () => { this.staged = true })
    // Squirrel failing to fetch or unpack what electron-updater downloaded: Restart and install-on-quit would both do nothing.
    env.nativeUpdater?.on('error', (e: unknown) => { if (!this.staged) this.dispatch({ type: 'install-failed', reason: reasonOf(e) }) })
  }

  current(): UpdateState { return this.state }

  /** First check now, then every CHECK_EVERY_MS; the stall watch every TICK_MS. */
  start(): void {
    if (this.frozen || this.state.kind === 'dev') return
    this.check()
    setInterval(() => this.check(), CHECK_EVERY_MS).unref()
    setInterval(() => this.tick(), TICK_MS).unref()
  }

  /**
   * One check; false when it didn't start: one is in flight, a download runs, a dev or frozen run, or an update is ready
   * (it stays offered; checking again would download and hand it to Squirrel again, and on Windows and Linux a failed newer
   * download deletes the staged one). The app checks again at its next start.
   */
  check(): boolean {
    const k = this.state.kind
    if (this.frozen || k === 'dev' || k === 'ready' || k === 'downloading' || this.checking || (this.stopping && this.now() - this.stoppingSince < STALL_ABORT_MS)) return false
    this.checking = true
    const work = this.selfUpdating ? this.checkSelf() : this.checkManual()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), CHECK_TIMEOUT_MS) })
    void Promise.race([work.then(() => 'done' as const), timeout]).then((r) => {
      clearTimeout(timer)
      this.checking = false
      // From 'failed' a retry never left 'failed' (US-04), so the timeout must answer there too, or the chip waits on it.
      if (r === 'timeout' && (this.state.kind === 'checking' || this.state.kind === 'failed' || this.state.kind === 'waiting')) this.dispatch({ type: 'error', reason: `the update server didn't answer in ${CHECK_TIMEOUT_MS / 1000} s` })
    })
    return true
  }

  private async checkManual(): Promise<void> {
    this.dispatch({ type: 'checking' })
    try {
      const found = await this.env.checkForUpdate(this.env.version, ((url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS / 2) })) as typeof fetch)
      this.dispatch(found ? { type: 'manual', next: found.version, url: found.url } : { type: 'none' })
    } catch (e) { this.dispatch({ type: 'error', reason: reasonOf(e) }) }
  }

  private autoUpdater(): Promise<AutoUpdaterLike> {
    return (this.auto ??= this.env.loadAutoUpdater().then((au) => {
      // The updater decides when to download: never while the user's own job runs (US-19).
      au.autoDownload = false
      au.autoInstallOnAppQuit = true
      if (this.feed) {
        // A dev run reads its feed from dev-app-update.yml; this one sits in the run's own data folder and downloads into a cache
        // folder of its own, never the installed app's (hindsight-updater).
        const config = join(this.env.userData, 'dev-app-update.yml')
        writeFileSync(config, `provider: generic\nurl: ${JSON.stringify(this.feed)}\nupdaterCacheDirName: hindsight-dev-updater\n`)
        au.forceDevUpdateConfig = true
        au.updateConfigPath = config
      }
      au.on('checking-for-update', () => this.dispatch({ type: 'checking' }))
      au.on('update-not-available', () => this.dispatch({ type: 'none' }))
      au.on('update-available', (info: { version: string }) => {
        this.staged = false
        const job = this.deps.runningJob()
        this.dispatch(job ? { type: 'wait', next: info.version, job } : { type: 'available', next: info.version })
      })
      au.on('download-progress', (p: { transferred: number; total: number; bytesPerSecond: number }) => this.dispatch({ type: 'progress', transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }))
      au.on('update-downloaded', (info: { version: string }) => this.dispatch({ type: 'downloaded', next: info.version }))
      au.on('error', (e: unknown) => {
        if (this.gaveUp && /cancel/i.test(reasonOf(e))) return
        // MacUpdater repeats Squirrel's errors as its own: keep the fuller reason install-failed already gave.
        if (this.state.kind === 'failed' && this.state.reason.includes(reasonOf(e))) return
        this.dispatch({ type: 'error', reason: reasonOf(e) })
      })
      return au
    }))
  }

  private async checkSelf(): Promise<void> {
    try {
      const au = await this.autoUpdater()
      this.gaveUp = false
      const result = await au.checkForUpdates()
      // null: electron-updater isn't active here (a Linux copy not run as an AppImage) and said nothing.
      if (!result) { if (this.state.kind === 'checking') this.dispatch({ type: 'error', reason: "this copy can't update itself" }); return }
      // 'update-available' already chose: downloading (nothing of the user's runs) or waiting (it starts after, from tick()).
      if (!result.isUpdateAvailable || this.state.kind !== 'downloading') return
      // A job that started during the check also comes first.
      const job = this.deps.runningJob()
      if (job) { this.dispatch({ type: 'wait', next: this.state.next, job }); return }
      const token = result.cancellationToken
      this.cancelDownload = token ? () => token.cancel() : null
      // A failed download rejects this promise and also emits 'error', which is what the chip hears; without this catch the
      // rejection is unhandled.
      const download: Promise<unknown> = au.downloadUpdate(token).catch(() => {}).finally(() => {
        if (this.inFlight === download) { this.inFlight = null; this.stopping = false }
      })
      this.inFlight = download
    } catch (e) { this.dispatch({ type: 'error', reason: reasonOf(e) }) }
  }

  /**
   * The stall watch: a download with no new bytes for STALL_ABORT_MS is cancelled and reported, so Retry (or the next check)
   * can start it again. Time asleep doesn't count: after a gap of more than STALL_MS between ticks the wait starts again.
   */
  tick(): void {
    const now = this.now()
    if (now - this.lastTick > STALL_MS) this.awakeAt = now
    this.lastTick = now
    const s = this.state
    const job = this.deps.runningJob()
    // The user's own work comes first (US-19): a download in progress stops (at most one update's changed blocks, ~5 MB,
    // are fetched again) and waits; a waiting one starts with a fresh check once nothing of the user's runs.
    if (s.kind === 'downloading' && job) {
      this.stop()
      this.dispatch({ type: 'wait', next: s.next, job })
      return
    }
    if (s.kind === 'waiting') { if (!job) this.check(); return }
    if (s.kind !== 'downloading' || now - Math.max(s.lastDataAt, this.awakeAt) < STALL_ABORT_MS) return
    const mb = (n: number) => Math.round(n / 1e6)
    this.stop()
    const quiet = `no data for ${Math.round(STALL_ABORT_MS / 1000)} s`
    this.dispatch({ type: 'error', reason: s.total > 0 ? `the download of ${s.next} stopped at ${mb(s.transferred)} of ${mb(s.total)} MB (${quiet})` : `the download of ${s.next} got ${quiet}` })
  }

  /** Cancel the download in flight; no check starts until it has ended (`stopping`). */
  private stop(): void {
    this.gaveUp = true
    this.cancelDownload?.()
    this.cancelDownload = null
    if (this.inFlight) { this.stopping = true; this.stoppingSince = this.now() }
  }

  /**
   * Install the downloaded update and relaunch. Only in `ready`. With a job running it asks first (`busy`) unless forced. On a
   * Mac it waits until Squirrel has staged the update (`preparing`): asked earlier, electron-updater would leave a listener
   * that quits and installs whenever Squirrel finishes, which is a restart nobody asked for at that moment.
   */
  restart(force: boolean): RestartAnswer {
    if (this.state.kind !== 'ready' || this.frozen) return {}
    if (this.env.nativeUpdater && !this.staged) return { preparing: true }
    const busy = this.deps.runningJob()
    if (busy && !force) return { busy }
    this.deps.log(`update: restarting to install ${this.state.next}`)
    void this.autoUpdater().then((au) => au.quitAndInstall(true, true)).catch((e) => this.deps.log(`update: restart failed: ${reasonOf(e)}`))
    return { started: true }
  }

  private dispatch(e: UpdateEvent): void {
    // Runs inside electron-updater's emit: a throw here would abort its install steps (Squirrel staging, the quit handler).
    try {
      const before = this.state
      const after = step(before, e, this.now())
      this.state = after
      this.logTransition(before, after, e)
      if (after !== before) this.deps.send(after)
    } catch (err) {
      try { this.deps.log(`update: could not record ${e.type}: ${reasonOf(err)}`) } catch { /* never throw into the updater */ }
    }
  }

  private logTransition(before: UpdateState, after: UpdateState, e: UpdateEvent): void {
    const log = this.deps.log
    if (e.type === 'checking' && (after.kind === 'checking' || after.kind === 'failed')) log('update: checking')
    else if (e.type === 'none' && after.kind === 'current') log(`update: up to date (${after.version})`)
    else if (e.type === 'available' && after.kind === 'downloading' && !(before.kind === 'downloading' && before.next === after.next)) log(`update: downloading ${after.next}`)
    else if (e.type === 'downloaded' && after.kind === 'ready' && !(before.kind === 'ready' && before.next === after.next)) log(`update: downloaded ${after.next}, installs on quit`)
    else if ((e.type === 'error' || e.type === 'install-failed') && after.kind === 'failed' && !(before.kind === 'failed' && before.reason === after.reason)) log(`update: failed: ${after.reason}`)
    // A staged update stays offered, but an error now is still worth a line.
    else if (e.type === 'error' && after.kind === 'ready') log(`update: error while ${after.next} is staged: ${e.reason}`)
    else if (e.type === 'manual' && after.kind === 'manual') log(`update: ${after.next} is out (manual download)`)
    else if (e.type === 'wait' && after.kind === 'waiting' && after !== before) log(`update: ${after.next} waits for ${after.job}`)
  }
}
