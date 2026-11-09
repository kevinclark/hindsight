/**
 * The app's updater: owns the one `UpdateState` (src/hub/update-state.ts), feeds it what the update source says, tells the
 * window each new state and writes the notable ones to the job log. Installed Windows, Linux and signed Mac builds use
 * electron-updater (it downloads in the background and installs on quit); an unsigned Mac build can't, so it asks the public
 * repo's releases and the chip offers the download link. Never restarts by itself: only `restart()`, which the user asks for.
 */
import { app } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { selfUpdates, checkForUpdate } from '../src/hub/update.ts'
import { CHECK_EVERY_MS, STALL_ABORT_MS, initial, step, type UpdateEvent, type UpdateState } from '../src/hub/update-state.ts'


export interface UpdaterDeps {
  /** The job log's `line` (the same instance hub-ipc's jobs write to). Byte progress is never written. */
  log: (line: string) => void
  /** Tell the window the new state. */
  send: (state: UpdateState) => void
  /** The name of the job running now, or null. */
  runningJob: () => string | null
  now?: () => number
}

type AutoUpdater = (typeof import('electron-updater'))['autoUpdater']

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200) || 'unknown error'

export class Updater {
  private state: UpdateState
  private readonly selfUpdating: boolean
  private readonly packaged = app.isPackaged
  private readonly now: () => number
  private checking = false
  private frozen = false
  private auto: Promise<AutoUpdater> | null = null
  /** Cancels the download in flight (electron-updater's token from the check that started it). */
  private cancelDownload: (() => void) | null = null
  /** Set when we gave up a stalled download, so electron-updater's own 'cancelled' error doesn't replace our reason. */
  private gaveUp = false

  private readonly deps: UpdaterDeps

  constructor(deps: UpdaterDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    const feed = !this.packaged ? process.env.HINDSIGHT_UPDATE_FEED : undefined
    // Dev-only test hook: a local server stands in for the release feed, so real electron-updater events can be exercised.
    this.selfUpdating = !!feed || selfUpdates({ isPackaged: this.packaged, platform: process.platform, macSigned: typeof __MAC_SIGNED__ === 'boolean' && __MAC_SIGNED__ })
    this.state = initial(app.getVersion(), this.selfUpdating, this.packaged)
    // Dev-only test hook for screenshots: start in the given state and run no checks.
    const forced = !this.packaged ? process.env.HINDSIGHT_UPDATE_STATE : undefined
    if (forced) {
      try { this.state = JSON.parse(forced) as UpdateState; this.frozen = true } catch { /* not JSON: ignored, the run checks as usual */ }
    }
  }

  current(): UpdateState { return this.state }

  /** First check now, then every CHECK_EVERY_MS. */
  start(): void {
    if (this.frozen || this.state.kind === 'dev') return
    void this.check()
    setInterval(() => void this.check(), CHECK_EVERY_MS).unref()
    setInterval(() => this.watchStall(), 5_000).unref()
  }

  /** One check; ignored while one is in flight, while a download runs, and in a dev run. */
  async check(): Promise<void> {
    if (this.frozen || this.state.kind === 'dev' || this.checking || this.state.kind === 'downloading') return
    this.checking = true
    try {
      if (this.selfUpdating) await this.checkSelf()
      else await this.checkManual()
    } finally { this.checking = false }
  }

  private async checkManual(): Promise<void> {
    this.dispatch({ type: 'checking' })
    try {
      const found = await checkForUpdate(app.getVersion())
      this.dispatch(found ? { type: 'manual', next: found.version, url: found.url } : { type: 'none' })
    } catch (e) { this.dispatch({ type: 'error', reason: reasonOf(e) }) }
  }

  private autoUpdater(): Promise<AutoUpdater> {
    return (this.auto ??= import('electron-updater').then((m) => {
      // autoUpdater is a lazy getter Node can't see as a named export of the CommonJS module: read it off the default.
      const au = (m.default ?? m).autoUpdater
      au.autoDownload = true
      au.autoInstallOnAppQuit = true
      const feed = !this.packaged ? process.env.HINDSIGHT_UPDATE_FEED : undefined
      if (feed) {
        // A dev run reads its feed from dev-app-update.yml; this one sits in the run's own data folder and downloads into a cache
        // folder of its own, never the installed app's (hindsight-updater).
        const config = join(app.getPath('userData'), 'dev-app-update.yml')
        writeFileSync(config, `provider: generic\nurl: ${JSON.stringify(feed)}\nupdaterCacheDirName: hindsight-dev-updater\n`)
        au.forceDevUpdateConfig = true
        au.updateConfigPath = config
      }
      au.on('checking-for-update', () => this.dispatch({ type: 'checking' }))
      au.on('update-not-available', () => this.dispatch({ type: 'none' }))
      au.on('update-available', (info) => this.dispatch({ type: 'available', next: info.version }))
      au.on('download-progress', (p) => this.dispatch({ type: 'progress', transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }))
      au.on('update-downloaded', (info) => this.dispatch({ type: 'downloaded', next: info.version }))
      au.on('error', (e) => {
        if (this.gaveUp && /cancel/i.test(reasonOf(e))) return
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
      const token = result?.cancellationToken
      this.cancelDownload = token ? () => token.cancel() : null
      // A failed download rejects this promise and also emits 'error', which is what the chip hears; without this catch the
      // rejection is unhandled.
      result?.downloadPromise?.catch(() => {})
    } catch (e) { this.dispatch({ type: 'error', reason: reasonOf(e) }) }
  }

  /** A download with no new bytes for STALL_ABORT_MS is cancelled and reported, so Retry (or the next check) can start it again. */
  private watchStall(): void {
    const s = this.state
    if (s.kind !== 'downloading' || this.now() - s.lastDataAt < STALL_ABORT_MS) return
    const mb = (n: number) => Math.round(n / 1e6)
    this.gaveUp = true
    this.cancelDownload?.()
    this.cancelDownload = null
    const quiet = `no data for ${Math.round(STALL_ABORT_MS / 1000)} s`
    this.dispatch({ type: 'error', reason: s.total > 0 ? `the download of ${s.next} stopped at ${mb(s.transferred)} of ${mb(s.total)} MB (${quiet})` : `the download of ${s.next} got ${quiet}` })
  }

  /** Install the downloaded update and relaunch. Only in `ready`; with a job running it asks first (`{ busy }`) unless forced. */
  restart(force: boolean): { busy?: string } {
    if (this.state.kind !== 'ready' || this.frozen) return {}
    const busy = this.deps.runningJob()
    if (busy && !force) return { busy }
    this.deps.log(`update: restarting to install ${this.state.next}`)
    void this.autoUpdater().then((au) => au.quitAndInstall(true, true)).catch((e) => this.deps.log(`update: restart failed: ${reasonOf(e)}`))
    return {}
  }

  private dispatch(e: UpdateEvent): void {
    const before = this.state
    const after = step(before, e, this.now())
    this.state = after
    this.logTransition(before, after, e)
    if (after !== before) this.deps.send(after)
  }

  private logTransition(before: UpdateState, after: UpdateState, e: UpdateEvent): void {
    const log = this.deps.log
    if (e.type === 'checking' && (after.kind === 'checking' || after.kind === 'failed')) log('update: checking')
    else if (e.type === 'none' && after.kind === 'current') log(`update: up to date (${after.version})`)
    else if (e.type === 'available' && after.kind === 'downloading' && !(before.kind === 'downloading' && before.next === after.next)) log(`update: downloading ${after.next}`)
    else if (e.type === 'downloaded' && after.kind === 'ready' && !(before.kind === 'ready' && before.next === after.next)) log(`update: downloaded ${after.next}, installs on quit`)
    else if (e.type === 'error' && after.kind === 'failed' && !(before.kind === 'failed' && before.reason === after.reason)) log(`update: failed: ${after.reason}`)
    // A staged update stays offered, but an error now (macOS unpacking it, or a later check) is still worth a line: Restart may not work.
    else if (e.type === 'error' && after.kind === 'ready') log(`update: error while ${after.next} is staged: ${e.reason}`)
    else if (e.type === 'manual' && after.kind === 'manual') log(`update: ${after.next} is out (manual download)`)
  }
}
