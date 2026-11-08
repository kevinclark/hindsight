// A laptop pushes its own history and event files without a Sync (a burst of marks is one push, ~10 s after the last), and
// pulls teammates' history every 2 min, reading only the tail and checking it against Drive's checksum. Nothing runs until a
// sign-in is in use this run; "sign in again" stops it. Invented data only.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAdapter } from '../src/hub/memory-adapter.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { SignInAgain, readText, type StorageAdapter } from '../src/hub/adapter.ts'
import { syncWithTeam } from '../src/hub/sync.ts'
import { Lock, LiveShare, MARK_PUSH_DELAY_MS, SHARE_EVERY_MS } from '../src/hub/live-share.ts'

let work: string
beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-live-')); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
afterEach(async () => { vi.useRealTimers(); await rm(work, { recursive: true, force: true }) })

const issue = (n: number) => `${JSON.stringify({ type: 'issue', key: `mech/test · Arm ${n}`, status: 'known', note: 'test reason', when: `2099-03-05T10:${String(n).padStart(2, '0')}:00.000Z` })}\n`
const bytes = (t: string) => new TextEncoder().encode(t).length
const md5 = (t: string) => createHash('md5').update(t).digest('hex')

/** A team store that counts what it is asked, and can be made to fail. */
class Spy extends MemoryAdapter {
  appends: string[] = []
  reads: { path: string; start: number; end: number }[] = []
  lists: string[] = []
  fail: Error | null = null
  corruptTail = false
  override async list(prefix: string) { if (this.fail) throw this.fail; this.lists.push(prefix); return super.list(prefix) }
  override async stat(path: string) { if (this.fail) throw this.fail; return super.stat(path) }
  override async read(path: string, start: number, end: number) {
    if (this.fail) throw this.fail
    this.reads.push({ path, start, end })
    const bytes = await super.read(path, start, end)
    return this.corruptTail && start > 0 ? new TextEncoder().encode('{"garbled":true}\n'.slice(0, bytes.length).padEnd(bytes.length, ' ')) : bytes
  }
  override async appendManifest(path: string, content: string) { if (this.fail) throw this.fail; this.appends.push(path); return super.appendManifest(path, content) }
}

async function setup() {
  const lib = await LocalLibrary.open(join(work, 'a'), 'laptop-a')
  const team = new Spy()
  const changed = vi.fn()
  const folder: { store: Spy | null } = { store: team }
  const share = new LiveShare({ lib, team: async () => folder.store as StorageAdapter | null, lock: new Lock(), md5, onHistoryChanged: changed })
  return { lib, team, share, changed, folder }
}
/** Let the promises a timer started run to the end. */
// Real disk writes finish on their own clock: 30 turns of the event loop, and at least 50 ms of real time (slow CI runners).
const settle = async () => { const until = performance.now() + 50; for (let i = 0; i < 30 || performance.now() < until; i++) { await vi.advanceTimersByTimeAsync(0); await new Promise((r) => setImmediate(r)) } }

describe('pushing without a Sync', () => {
  it('a burst of marks is one push, about 10 s after the last mark', async () => {
    const { lib, team, share } = await setup()
    share.signInUsed()
    await settle()
    team.appends.length = 0
    for (let n = 1; n <= 5; n++) {
      await lib.appendHistory(issue(n))
      share.noteMark()
      await vi.advanceTimersByTimeAsync(2_000)
    }
    expect(team.appends).toEqual([])
    await vi.advanceTimersByTimeAsync(MARK_PUSH_DELAY_MS)
    await settle()
    expect(team.appends).toEqual(['history/laptop-a.jsonl'])
    expect(await readText(team, 'history/laptop-a.jsonl')).toBe(await readText(lib.store, 'history/laptop-a.jsonl'))
    expect((await share.status()).notUp.marks).toBe(0)
  })

  it('no timer runs and nothing is sent before a sign-in is used this run', async () => {
    const { lib, team, share } = await setup()
    await lib.appendHistory(issue(1))
    share.noteMark()
    share.noteEvent('2099test')
    await vi.advanceTimersByTimeAsync(10 * SHARE_EVERY_MS)
    expect(vi.getTimerCount()).toBe(0)
    expect(team.appends).toEqual([])
    expect(team.lists).toEqual([])
    expect((await share.status())).toMatchObject({ running: false, notUp: { marks: 1 } })
    // the first Drive action that got a token starts it, and the waiting mark goes up
    share.signInUsed()
    await settle()
    expect(team.appends).toEqual(['history/laptop-a.jsonl'])
    expect((await share.status()).running).toBe(true)
  })

  it('"sign in again" stops the timers and says so; a sign-in in use starts them again', async () => {
    const { lib, team, share } = await setup()
    share.signInUsed()
    await settle()
    team.fail = new SignInAgain()
    await lib.appendHistory(issue(1))
    share.noteMark()
    await vi.advanceTimersByTimeAsync(MARK_PUSH_DELAY_MS)
    await settle()
    expect((await share.status())).toMatchObject({ running: false, signInNeeded: true, notUp: { marks: 1 } })
    expect(vi.getTimerCount()).toBe(0)
    share.noteMark() // a mark while signed out waits; no timer
    expect(vi.getTimerCount()).toBe(0)
    team.fail = null
    share.signInUsed()
    await settle()
    expect((await share.status())).toMatchObject({ running: true, signInNeeded: false, notUp: { marks: 0 } })
  })

  it('with no signal a push is tried again on the next mark and every 2 min, and the waiting marks are counted', async () => {
    const { lib, team, share } = await setup()
    share.signInUsed()
    await settle()
    team.fail = new Error('offline')
    await lib.appendHistory(issue(1) + issue(2) + issue(3))
    share.noteMark()
    await vi.advanceTimersByTimeAsync(MARK_PUSH_DELAY_MS)
    await settle()
    expect((await share.status())).toMatchObject({ running: true, notUp: { marks: 3 } })
    expect((await share.status()).problem).toMatch(/offline/)
    team.fail = null
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    expect((await share.status())).toMatchObject({ notUp: { marks: 0 }, problem: null })
  })

  it("an event file goes up after a log is added; a second push of the same content changes nothing; a team copy that isn't its start is never overwritten", async () => {
    const { lib, team, share } = await setup()
    share.signInUsed()
    await settle()
    const sha = 'a'.repeat(64)
    const line = JSON.stringify({ sha256: sha, analyzer: '0.1.9+aaaa', shape: 4, at: 1, summary: { fileName: 'q1.wpilog', rules: {}, metrics: {}, robot: {} } })
    await lib.appendEvent('2099test', `${line}\n`)
    share.noteEvent('2099test')
    await settle()
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(team.appends).toEqual(['events/2099test--laptop-a.jsonl'])
    share.noteEvent('2099test')
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    expect(team.appends).toEqual(['events/2099test--laptop-a.jsonl'])
    // another install with this machine id wrote something else there: kept, and said
    team.put('events/2099test--laptop-a.jsonl', 'someone else\n')
    await lib.appendEvent('2099test', `${line.replace('0.1.9+aaaa', '0.1.10+bbbb')}\n`)
    share.noteEvent('2099test')
    await vi.advanceTimersByTimeAsync(5_000)
    await settle()
    expect(await readText(team, 'events/2099test--laptop-a.jsonl')).toBe('someone else\n')
    expect((await share.status()).problem).toMatch(/events\/2099test--laptop-a\.jsonl/)
    expect((await share.status()).notUp.eventLines).toBe(2)
  })
})

describe('the team folder', () => {
  it('with none chosen yet nothing is sent and nothing is said (the person may be choosing it)', async () => {
    const { lib, team, share, folder } = await setup()
    folder.store = null
    await lib.appendHistory(issue(1))
    share.signInUsed()
    await settle()
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    expect(team.appends).toEqual([])
    expect(await share.status()).toMatchObject({ running: true, problem: null, notUp: { marks: 1 } })
  })

  it('another folder chosen: every own file goes up there too, even unchanged ones', async () => {
    const { lib, team, share, folder } = await setup()
    await lib.appendHistory(issue(1))
    share.signInUsed()
    await settle()
    expect(team.appends).toEqual(['history/laptop-a.jsonl'])
    const other = new Spy()
    folder.store = other
    share.teamChanged()
    await settle()
    expect(other.appends).toEqual(['history/laptop-a.jsonl'])
    expect(await readText(other, 'history/laptop-a.jsonl')).toBe(issue(1))
  })
})

describe("pulling teammates' history every 2 min", () => {
  it('reads only the tail of a file that grew, and tells the page the history changed', async () => {
    const { lib, team, share, changed } = await setup()
    team.put('history/laptop-b.jsonl', issue(1))
    share.signInUsed()
    await settle()
    expect(await readText(lib.store, 'history/laptop-b.jsonl')).toBe(issue(1))
    expect(changed).toHaveBeenCalledTimes(1)
    team.reads.length = 0
    team.put('history/laptop-b.jsonl', issue(1) + issue(2))
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    expect(team.reads.filter((r) => r.path === 'history/laptop-b.jsonl')).toEqual([{ path: 'history/laptop-b.jsonl', start: bytes(issue(1)), end: bytes(issue(1) + issue(2)) }])
    expect(await readText(lib.store, 'history/laptop-b.jsonl')).toBe(issue(1) + issue(2))
    expect(changed).toHaveBeenCalledTimes(2)
    // unchanged: nothing read, nothing said
    team.reads.length = 0
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    expect(team.reads).toEqual([])
    expect(changed).toHaveBeenCalledTimes(2)
    expect((await share.status()).teammatesAsOf).not.toBeNull()
  })

  it('a pulled tail that fails the checksum is fetched whole', async () => {
    const { lib, team, share } = await setup()
    team.put('history/laptop-b.jsonl', issue(1))
    share.signInUsed()
    await settle()
    team.put('history/laptop-b.jsonl', issue(1) + issue(2))
    team.corruptTail = true
    team.reads.length = 0
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    const reads = team.reads.filter((r) => r.path === 'history/laptop-b.jsonl')
    expect(reads.map((r) => r.start)).toEqual([bytes(issue(1)), 0])
    expect(await readText(lib.store, 'history/laptop-b.jsonl')).toBe(issue(1) + issue(2))
  })

  it("a teammate's copy is replaced only by a longer one that starts with it", async () => {
    const { lib, team, share, changed } = await setup()
    team.put('history/laptop-b.jsonl', issue(1) + issue(2))
    share.signInUsed()
    await settle()
    changed.mockClear()
    // shorter on Drive: kept
    team.put('history/laptop-b.jsonl', issue(1))
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    expect(await readText(lib.store, 'history/laptop-b.jsonl')).toBe(issue(1) + issue(2))
    // rewritten, longer, not starting with ours: kept, and said
    team.put('history/laptop-b.jsonl', issue(3) + issue(4) + issue(5))
    await vi.advanceTimersByTimeAsync(SHARE_EVERY_MS)
    await settle()
    expect(await readText(lib.store, 'history/laptop-b.jsonl')).toBe(issue(1) + issue(2))
    expect((await share.status()).problem).toMatch(/history\/laptop-b\.jsonl/)
    expect(changed).not.toHaveBeenCalled()
  })

  it("Sync's history step and the push take the same lock: neither reads or writes this laptop's file while the other does", async () => {
    const lib = await LocalLibrary.open(join(work, 'a'), 'laptop-a')
    const team = new Spy()
    const lock = new Lock()
    await lib.appendHistory(issue(1))
    let release!: () => void
    const held = lock.run(() => new Promise<void>((r) => { release = r }))
    vi.useRealTimers()
    const sync = syncWithTeam(lib, team, { lock })
    await new Promise((r) => setTimeout(r, 50))
    expect(team.appends).not.toContain('history/laptop-a.jsonl')
    release()
    await held
    await sync
    expect(team.appends).toContain('history/laptop-a.jsonl')
  })
})
