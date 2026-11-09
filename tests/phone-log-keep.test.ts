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
    const keep = new LogKeep(memoryKeepStore(), { capBytes: 250, maxLogBytes: 200, now: () => now++ })
    const a = bytes(100, 1), b = bytes(100, 2), c = bytes(100, 3)
    await keep.put(sha(a), a)
    await keep.put(sha(b), b)
    expect(await keep.get(sha(a))).toEqual(a) // a is now the most recently opened
    await keep.put(sha(c), c) // over the cap: b goes
    expect((await keep.kept()).sort()).toEqual([sha(a), sha(c)].sort())
    expect(await keep.get(sha(b))).toBeNull()
  })

  it('never keeps a log above the size limit', async () => {
    const keep = new LogKeep(memoryKeepStore(), { capBytes: 1000, maxLogBytes: 50 })
    const big = bytes(51, 4)
    await keep.put(sha(big), big)
    expect(await keep.kept()).toEqual([])
  })

  it('clear empties it', async () => {
    const keep = new LogKeep(memoryKeepStore(), { capBytes: 1000, maxLogBytes: 1000 })
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
    const { hub, downloads } = hubWith(new Map([[e.record.path, q]]), new LogKeep(memoryKeepStore(), { capBytes: 10_000, maxLogBytes: 10_000 }))
    expect((await hub.openLog(e))[0].bytes).toEqual(q)
    expect((await hub.openLog(e))[0].bytes).toEqual(q)
    expect(downloads).toEqual([e.record.path])
  })

  it('drops a kept copy that fails its sha-256 and downloads it again', async () => {
    const q = bytes(1000, 7)
    const e = entryOf(q)
    const store = memoryKeepStore()
    const keep = new LogKeep(store, { capBytes: 10_000, maxLogBytes: 10_000 })
    await keep.put(e.record.sha256, bytes(1000, 8)) // a damaged copy under the right key
    const { hub, downloads } = hubWith(new Map([[e.record.path, q]]), keep)
    expect((await hub.openLog(e))[0].bytes).toEqual(q)
    expect(downloads).toEqual([e.record.path])
  })
})
