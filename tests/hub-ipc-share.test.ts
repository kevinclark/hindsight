// The desktop app's wiring of the push without a Sync (electron/hub-ipc.ts): nothing is sent, and the sign-in is never
// asked for, until a Drive request of this run gets a token; "sign in again" stops it; one LiveShare however many callers.
// Electron, the sign-in and Drive are faked; the library is a real folder. Invented data only.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { readText } from '../src/hub/adapter.ts'
import { MARK_PUSH_DELAY_MS, SHARE_EVERY_MS } from '../src/hub/live-share.ts'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  dir: '',
  team: null as unknown as InstanceType<typeof import('../src/hub/memory-adapter.ts').MemoryAdapter>,
  tokenCalls: 0,
  failToken: null as Error | null,
  sent: [] as string[],
  SignInAgain: Error as new () => Error,
}))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.0', getPath: () => h.dir, isPackaged: false, on: () => {} },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { h.handlers.set(channel, fn) } },
  dialog: {},
  autoUpdater: { on: () => {} },
}))
vi.mock('../electron/describer.ts', () => ({ Describer: class { describe = async () => null; stop() {} } }))
vi.mock('../electron/settings.ts', () => ({
  loadSettings: async () => ({ machineId: 'laptop-a', libraryDir: join(h.dir, 'library'), teamFolder: { id: 'F', name: 'Team' } }),
  saveSettings: async (s: object) => s,
}))
vi.mock('../electron/google-auth.ts', () => ({
  // Getting a token source reads nothing; a token is asked for only when a request is made.
  driveToken: async () => async () => { h.tokenCalls++; if (h.failToken) throw h.failToken; return 'test-token' },
  googleClient: async () => ({ id: 'x', secret: 'y' }), keeping: () => ({ keeps: true, why: null }), signedIn: () => true,
  signIn: async () => {}, signOut: async () => {},
}))
// Drive as one shared in-memory store; every request asks the adapter's token source first, as the real adapter does.
vi.mock('../src/hub/drive-adapter.ts', () => ({
  DriveAdapter: class {
    private o: { token(refresh?: boolean): Promise<string> }
    constructor(o: { token(refresh?: boolean): Promise<string> }) { this.o = o }
    private async t() { await this.o.token() }
    async list(p: string) { await this.t(); return h.team.list(p) }
    async stat(p: string) { await this.t(); return h.team.stat(p) }
    async read(p: string, a: number, b: number) { await this.t(); return h.team.read(p, a, b) }
    async appendManifest(p: string, c: string) { await this.t(); return h.team.appendManifest(p, c) }
    async folderChoices() { await this.t(); return [] }
  },
}))

const issue = (n: number) => `${JSON.stringify({ type: 'issue', key: `mech/test · Arm ${n}`, status: 'known', note: 'test reason', when: `2099-03-05T10:0${n}:00.000Z` })}\n`
// Real disk writes finish on their own clock: 30 turns of the event loop, and at least 50 ms of real time (slow CI runners).
const settle = async () => { const until = performance.now() + 50; for (let i = 0; i < 30 || performance.now() < until; i++) { await vi.advanceTimersByTimeAsync(0); await new Promise((r) => setImmediate(r)) } }
const call = (channel: string, ...args: unknown[]) => h.handlers.get(channel)!({}, ...args) as Promise<unknown>

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  h.dir = await mkdtemp(join(tmpdir(), 'hindsight-ipc-'))
  h.handlers.clear()
  h.team = new MemoryAdapter()
  h.tokenCalls = 0
  h.failToken = null
  vi.resetModules()
  // The app's own SignInAgain class (resetModules gives the app fresh module copies; instanceof needs the same one).
  h.SignInAgain = (await import('../src/hub/adapter.ts')).SignInAgain
  const { registerHub } = await import('../electron/hub-ipc.ts')
  registerHub(() => ({ webContents: { send: (c: string) => { h.sent.push(c) } } }) as never)
})
afterEach(async () => { vi.useRealTimers(); await rm(h.dir, { recursive: true, force: true }) })

describe('the desktop app shares without a Sync', () => {
  it('a mark before any Drive request this run: no token asked, no timer, nothing sent; the first request starts it', async () => {
    await call('hub:appendHistory', issue(1))
    await vi.advanceTimersByTimeAsync(5 * SHARE_EVERY_MS)
    await settle()
    expect(h.tokenCalls).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(await h.team.stat('history/laptop-a.jsonl')).toBeNull()
    expect(await call('hub:shareStatus')).toMatchObject({ running: false, notUp: { marks: 1 } })
    // a Drive request of this run (the folder picker) got a token: the waiting mark goes up
    await call('hub:driveFolders', 'roots')
    await settle()
    expect(await readText(h.team, 'history/laptop-a.jsonl')).toBe(issue(1))
    // and a later mark goes up after the burst
    await call('hub:appendHistory', issue(2))
    await vi.advanceTimersByTimeAsync(MARK_PUSH_DELAY_MS)
    await settle()
    expect(await readText(h.team, 'history/laptop-a.jsonl')).toBe(issue(1) + issue(2))
  })

  it('"sign in again" stops every timer; signing out stops it too', async () => {
    await call('hub:driveFolders', 'roots')
    await settle()
    expect(await call('hub:shareStatus')).toMatchObject({ running: true })
    h.failToken = new h.SignInAgain()
    await call('hub:driveFolders', 'roots').catch(() => {})
    await settle()
    expect(await call('hub:shareStatus')).toMatchObject({ running: false, signInNeeded: true })
    expect(vi.getTimerCount()).toBe(0)
    h.failToken = null
    await call('hub:driveSignIn')
    await settle()
    expect(await call('hub:shareStatus')).toMatchObject({ running: true })
    await call('hub:driveSignOut')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('callers at once still make one sharing: after a sign-out no timer is left running', async () => {
    await Promise.all([call('hub:appendHistory', issue(1)), call('hub:shareStatus'), call('hub:driveFolders', 'roots'), call('hub:driveFolders', 'roots')])
    await settle()
    await call('hub:driveSignOut')
    await settle()
    expect(vi.getTimerCount()).toBe(0)
  })
})
