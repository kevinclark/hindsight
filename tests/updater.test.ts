// Contract tests for electron/updater.ts (docs/contracts/update-state.md, US-13..US-19), driven through fakes of
// electron-updater's autoUpdater and Squirrel.Mac's native updater. Made-up versions and times.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CHECK_TIMEOUT_MS, Updater, type AutoUpdaterLike, type UpdaterEnv } from '../electron/updater.ts'
import { STALL_ABORT_MS, step } from '../src/hub/update-state.ts'
import type { UpdateState } from '../src/hub/update-state.ts'

const V = '0.1.100'
const N = '0.1.101'

class FakeAuto extends EventEmitter implements AutoUpdaterLike {
  autoDownload = false
  autoInstallOnAppQuit = false
  cancelled = 0
  installs: [boolean | undefined, boolean | undefined][] = []
  /** What the next checkForUpdates does: emit events and resolve, or hang. */
  answer: 'available' | 'none' | 'hang' | 'null' = 'available'
  checks = 0
  async checkForUpdates() {
    this.checks++
    if (this.answer === 'hang') return new Promise<never>(() => {})
    if (this.answer === 'null') return null
    this.emit('checking-for-update')
    if (this.answer === 'none') { this.emit('update-not-available', { version: V }); return { downloadPromise: null } }
    this.emit('update-available', { version: N })
    return { cancellationToken: { cancel: () => { this.cancelled++ } }, downloadPromise: new Promise(() => {}) }
  }
  quitAndInstall(a?: boolean, b?: boolean) { this.installs.push([a, b]) }
}

function setup(o: { platform?: string; job?: string | null; send?: (s: UpdateState) => void } = {}) {
  let t = 1_762_000_000_000
  const auto = new FakeAuto()
  const native = o.platform === 'darwin' ? new EventEmitter() : null
  const env: UpdaterEnv = {
    version: V, packaged: true, platform: o.platform ?? 'win32', macSigned: true, userData: '/nonexistent',
    loadAutoUpdater: async () => auto, nativeUpdater: native,
    checkForUpdate: async () => null,
  }
  const sent: UpdateState[] = []
  const lines: string[] = []
  const u = new Updater(env, {
    log: (l) => lines.push(l), send: o.send ?? ((s) => sent.push(s)), runningJob: () => o.job ?? null, now: () => t,
  })
  return { u, auto, native, sent, lines, advance: (ms: number) => { t += ms }, at: () => t }
}
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('[US-13] install-failed', () => {
  test('[US-13] from ready it is failed with the reason; anywhere else it changes nothing', () => {
    const ready: UpdateState = { kind: 'ready', version: V, next: N }
    expect(step(ready, { type: 'install-failed', reason: 'bad zip' }, 5)).toMatchObject({ kind: 'failed', since: 5, checkedAt: null, reason: expect.stringContaining('bad zip') })
    const current: UpdateState = { kind: 'current', version: V, checkedAt: 1 }
    expect(step(current, { type: 'install-failed', reason: 'x' }, 5)).toBe(current)
  })
  test('[US-13] a Squirrel error before it staged the update fails ready; after staging it is ignored', async () => {
    const a = setup({ platform: 'darwin' })
    a.u.check(); await flush()
    a.auto.emit('update-downloaded', { version: N })
    expect(a.u.current().kind).toBe('ready')
    a.native!.emit('error', new Error('ditto failed'))
    expect(a.u.current()).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ditto failed') })
    a.auto.emit('error', new Error('ditto failed'))
    expect(a.u.current()).toMatchObject({ kind: 'failed', reason: expect.stringContaining("couldn't prepare") })
    const b = setup({ platform: 'darwin' })
    b.u.check(); await flush()
    b.auto.emit('update-downloaded', { version: N })
    b.native!.emit('update-downloaded')
    b.native!.emit('error', new Error('later network error'))
    expect(b.u.current().kind).toBe('ready')
  })
})

describe('[US-14] when a check runs', () => {
  test('[US-14] no check starts while one is in flight, a download runs or an update is ready', async () => {
    const s = setup()
    s.auto.answer = 'hang'
    expect(s.u.check()).toBe(true)
    expect(s.u.check()).toBe(false)
    const d = setup()
    d.u.check(); await flush()
    expect(d.u.current().kind).toBe('downloading')
    expect(d.u.check()).toBe(false)
    d.auto.emit('update-downloaded', { version: N })
    expect(d.u.current().kind).toBe('ready')
    expect(d.u.check()).toBe(false)
    expect(d.auto.checks).toBe(1)
  })
  test('[US-14] a finished check allows the next', async () => {
    const s = setup()
    s.auto.answer = 'none'
    expect(s.u.check()).toBe(true); await flush()
    expect(s.u.current().kind).toBe('current')
    expect(s.u.check()).toBe(true)
  })
})

describe('[US-15] a check that never answers', () => {
  test('[US-15] after CHECK_TIMEOUT_MS it is failed and a new check may start', async () => {
    const s = setup()
    s.auto.answer = 'hang'
    s.u.check(); await flush()
    s.auto.emit('checking-for-update')
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
    expect(s.u.current()).toMatchObject({ kind: 'failed', reason: expect.stringContaining("didn't answer") })
    expect(s.u.check()).toBe(true)
  })
  test('[US-15] a retry from failed that never answers also ends in failed (the chip stops waiting)', async () => {
    const s = setup()
    s.auto.answer = 'null'
    s.u.check(); await flush()
    expect(s.u.current().kind).toBe('failed')
    const before = s.sent.length
    s.auto.answer = 'hang'
    expect(s.u.check()).toBe(true)
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS)
    expect(s.sent.length).toBeGreaterThan(before)
    expect(s.u.current()).toMatchObject({ kind: 'failed', reason: expect.stringContaining("didn't answer") })
  })
  test('[US-15] a check that resolves with nothing (updater not active) is failed', async () => {
    const s = setup()
    s.auto.answer = 'null'
    s.u.check(); await flush()
    expect(s.u.current()).toMatchObject({ kind: 'failed', reason: "this copy can't update itself" })
  })
})

describe('[US-16] a stalled download', () => {
  test('[US-16] no data for STALL_ABORT_MS cancels the download and fails it, saying where it stopped', async () => {
    const s = setup()
    s.u.check(); await flush()
    s.auto.emit('download-progress', { transferred: 4e6, total: 40e6, bytesPerSecond: 1 })
    for (let i = 0; i < STALL_ABORT_MS / 5000; i++) { s.advance(5000); s.u.tick() }
    expect(s.auto.cancelled).toBe(1)
    expect(s.u.current()).toMatchObject({ kind: 'failed', reason: expect.stringContaining('stopped at 4 of 40 MB') })
    s.auto.emit('error', new Error('cancelled'))
    expect(s.u.current()).toMatchObject({ reason: expect.stringContaining('stopped at 4 of 40 MB') })
  })
  test('[US-16] time asleep does not count', async () => {
    const s = setup()
    s.u.check(); await flush()
    s.advance(10 * 60_000); s.u.tick()
    expect(s.u.current().kind).toBe('downloading')
    for (let i = 0; i < STALL_ABORT_MS / 5000 - 1; i++) { s.advance(5000); s.u.tick() }
    expect(s.u.current().kind).toBe('downloading')
  })
})

describe('[US-17] Restart now', () => {
  test('[US-17] a Mac waits for Squirrel to stage the update before it will restart', async () => {
    const s = setup({ platform: 'darwin' })
    s.u.check(); await flush()
    s.auto.emit('update-downloaded', { version: N })
    expect(s.u.restart(false)).toEqual({ preparing: true })
    s.native!.emit('update-downloaded')
    expect(s.u.restart(false)).toEqual({ started: true }); await flush()
    expect(s.auto.installs).toEqual([[true, true]])
  })
  test('[US-17] a running job is named and nothing happens unless forced', async () => {
    const s = setup({ job: 'Sync' })
    s.u.check(); await flush()
    s.auto.emit('update-downloaded', { version: N })
    expect(s.u.restart(false)).toEqual({ busy: 'Sync' }); await flush()
    expect(s.auto.installs).toEqual([])
    expect(s.u.restart(true)).toEqual({ started: true }); await flush()
    expect(s.auto.installs).toEqual([[true, true]])
  })
  test('[US-17] outside ready it does nothing', async () => {
    const s = setup()
    s.u.check(); await flush()
    expect(s.u.restart(true)).toEqual({})
    expect(s.auto.installs).toEqual([])
  })
})

describe('[US-18] never throws into electron-updater', () => {
  test('[US-18] a send that throws is logged, and the event still lands', async () => {
    const s = setup({ send: () => { throw new Error('window gone') } })
    s.u.check(); await flush()
    expect(() => s.auto.emit('update-downloaded', { version: N })).not.toThrow()
    expect(s.u.current().kind).toBe('ready')
    expect(s.lines.some((l) => l.includes('window gone'))).toBe(true)
  })
})
