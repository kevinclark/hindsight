// Logs the phone keeps after opening them: by sha-256, up to a byte cap, the least recently opened dropped first; a log
// above the size limit is never kept; reopening a kept log reads no Drive bytes; a kept copy that fails its sha-256 is
// dropped and downloaded again; Sign out empties it. Invented data only.
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { LogKeep, memoryKeepStore } from '../src/hub/log-keep.ts'
import { BrowserHub } from '../src/hub/browser-hub.ts'
import { memoryCache } from '../src/hub/phone-cache.ts'
import type { Entry } from '../src/hub/catalog.ts'
import type { LogRecord } from '../src/hub/types.ts'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 13 + seed) & 255)

describe('LogKeep', () => {
  it('keeps logs up to the cap, dropping the least recently opened first', async () => {
    let now = 0
    const keep = new LogKeep(memoryKeepStore(), { capBytes: 250, now: () => now++ })
    const a = bytes(100, 1), b = bytes(100, 2), c = bytes(100, 3)
    await keep.put(sha(a), a)
    await keep.put(sha(b), b)
    expect(await keep.get(sha(a))).toEqual(a) // a is now the most recently opened
    await keep.put(sha(c), c) // over the cap: b goes
    expect((await keep.kept()).sort()).toEqual([sha(a), sha(c)].sort())
    expect(await keep.get(sha(b))).toBeNull()
  })

  it('keeps a big log when it fits the cap, and never one bigger than the cap', async () => {
    const keep = new LogKeep(memoryKeepStore(), { capBytes: 1000 })
    const big = bytes(900, 4), huge = bytes(1001, 5)
    await keep.put(sha(big), big)
    await keep.put(sha(huge), huge)
    expect(await keep.kept()).toEqual([sha(big)])
  })

  it('a smaller cap drops the least recently opened at once, and 0 keeps nothing', async () => {
    let now = 0
    const keep = new LogKeep(memoryKeepStore(), { capBytes: 1000, now: () => now++ })
    const a = bytes(300, 1), b = bytes(300, 2), c = bytes(300, 3)
    for (const x of [a, b, c]) await keep.put(sha(x), x)
    expect(await keep.used()).toBe(900)
    await keep.setCap(650)
    expect((await keep.kept()).sort()).toEqual([sha(b), sha(c)].sort())
    await keep.setCap(0)
    expect(await keep.kept()).toEqual([])
    await keep.put(sha(a), a)
    expect(await keep.kept()).toEqual([])
  })

  it('clear empties it', async () => {
    const keep = new LogKeep(memoryKeepStore(), { capBytes: 1000 })
    const a = bytes(10, 5)
    await keep.put(sha(a), a)
    await keep.clear()
    expect(await keep.kept()).toEqual([])
  })
})

describe('openLog with a keep', () => {
  const rec = (content: Uint8Array, name: string): LogRecord => ({ type: 'log', kind: 'wpilog', sha256: sha(content), size: content.length, path: `logs/2098-2099/2099-03-05/${name}`, names: [name] }) as unknown as LogRecord
  const entryOf = (content: Uint8Array): Pick<Entry, 'record' | 'attached'> => ({ record: rec(content, 'q.wpilog'), attached: { dslog: [], dsevents: [], hoot: [] } })
  function hubWith(files: Map<string, Uint8Array>, keep: LogKeep) {
    const downloads: string[] = []
    const media = { downloadWhole: async (path: string) => { downloads.push(path); return files.get(path)! } }
    const store = { list: async () => [], stat: async () => null, read: async () => new Uint8Array(0) }
    return { hub: new BrowserHub({ store, cache: memoryCache(), version: 't', media, keep }), downloads }
  }

  it('reopens a kept log without reading Drive', async () => {
    const q = bytes(1000, 6)
    const e = entryOf(q)
    const { hub, downloads } = hubWith(new Map([[e.record.path, q]]), new LogKeep(memoryKeepStore(), { capBytes: 10_000, }))
    expect((await hub.openLog(e))[0].bytes).toEqual(q)
    expect((await hub.openLog(e))[0].bytes).toEqual(q)
    expect(downloads).toEqual([e.record.path])
  })

  it('drops a kept copy that fails its sha-256 and downloads it again', async () => {
    const q = bytes(1000, 7)
    const e = entryOf(q)
    const store = memoryKeepStore()
    const keep = new LogKeep(store, { capBytes: 10_000, })
    await keep.put(e.record.sha256, bytes(1000, 8)) // a damaged copy under the right key
    const { hub, downloads } = hubWith(new Map([[e.record.path, q]]), keep)
    expect((await hub.openLog(e))[0].bytes).toEqual(q)
    expect(downloads).toEqual([e.record.path])
  })
})

describe('the phone keep on IndexedDB', () => {
  it('round-trips a log through Blobs, lists it, touches it, and Sign out empties both phone stores', async () => {
    const { IDBFactory, IDBKeyRange } = await import('fake-indexeddb')
    Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange })
    const { indexedDbKeepStore } = await import('../src/hub/log-keep.ts')
    const { forgetPhoneData, keptLogs } = await import('../src/phone.ts')
    const { indexedDbCache } = await import('../src/hub/phone-cache.ts')
    const store = indexedDbKeepStore('hindsight-logs', 1000) // 1000-byte pieces: a 3000-byte log is 3 of them
    const a = bytes(3500, 9)
    await store.write({ sha256: sha(a), size: a.length, usedAt: 1 }, a)
    expect(await store.read(sha(a))).toEqual(a)
    expect(await store.read('0'.repeat(64))).toBeNull()
    const pieces = () => new Promise<number>((resolve) => {
      const r = indexedDB.open('hindsight-logs')
      r.onsuccess = () => { const c = r.result.transaction('pieces').objectStore('pieces').count(); c.onsuccess = () => { r.result.close(); resolve(c.result) } }
    })
    expect(await pieces()).toBe(4)
    await store.remove(sha(a))
    expect(await pieces()).toBe(0)
    await store.write({ sha256: sha(a), size: a.length, usedAt: 1 }, a)
    await store.touch(sha(a), 5)
    expect(await store.meta()).toEqual([{ sha256: sha(a), size: a.length, usedAt: 5 }])
    const text = indexedDbCache()
    await text.put({ path: 'history/x.jsonl', size: 1, sha256: 'x', text: 'x' })
    await forgetPhoneData()
    expect(await keptLogs().kept()).toEqual([])
    expect(await indexedDbCache().get('history/x.jsonl')).toBeNull()
  })
})

describe('LogKeep when storage refuses', () => {
  it('drops the oldest and tries once more when a write is refused (a full quota)', async () => {
    const inner = memoryKeepStore()
    let refuse = true
    const store = { ...inner, write: async (m: Parameters<typeof inner.write>[0], b: Uint8Array) => { if (refuse && (await inner.meta()).length >= 2) { refuse = false; throw new DOMException('full', 'QuotaExceededError') } return inner.write(m, b) } }
    let now = 0
    const keep = new LogKeep(store, { capBytes: 1000, now: () => now++ })
    const a = bytes(100, 1), b = bytes(100, 2), c = bytes(100, 3)
    await keep.put(sha(a), a)
    await keep.put(sha(b), b)
    await keep.put(sha(c), c)
    expect((await keep.kept()).sort()).toEqual([sha(b), sha(c)].sort())
  })

  it('makes room before writing, so the keep never goes over its cap even for a moment', async () => {
    const inner = memoryKeepStore()
    let most = 0
    const store = { ...inner, write: async (m: Parameters<typeof inner.write>[0], b: Uint8Array) => { await inner.write(m, b); most = Math.max(most, (await inner.meta()).reduce((n, x) => n + x.size, 0)) } }
    let now = 0
    const keep = new LogKeep(store, { capBytes: 250, now: () => now++ })
    for (let i = 0; i < 5; i++) await keep.put(sha(bytes(100, 10 + i)), bytes(100, 10 + i))
    expect(most).toBeLessThanOrEqual(250)
  })
})

describe('the keep size setting', () => {
  it('defaults to 1 GB, remembers a choice from the list, and ignores anything else', async () => {
    const { KEEP_CHOICES, keepCap, setKeepCap } = await import('../src/phone/keep-setting.ts')
    const m = new Map<string, string>()
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    expect(keepCap(store)).toBe(2 ** 30)
    expect(KEEP_CHOICES.map((c) => c.bytes)).toEqual([0, 500 * 2 ** 20, 2 ** 30, 2 * 2 ** 30, 5 * 2 ** 30])
    setKeepCap(store, 2 * 2 ** 30)
    expect(keepCap(store)).toBe(2 * 2 ** 30)
    m.set('hindsight.phone.keepBytes', '12345')
    expect(keepCap(store)).toBe(2 ** 30)
  })
})
