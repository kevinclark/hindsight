/**
 * Logs the phone keeps after opening them, so opening one again reads no Drive bytes. Keyed by the log's sha-256; up to
 * `capBytes` in all, the least recently opened dropped first; a log over `maxLogBytes` is never kept (storing it means a
 * second full copy in memory for a moment). Kept in IndexedDB as Blobs, apart from the text cache (src/hub/phone-cache.ts).
 * Every failure (private storage, quota, a blocked database) behaves as an empty keep: the phone downloads again.
 *
 * No `node:` imports.
 */

export interface KeptMeta { sha256: string; size: number; usedAt: number }

/** Where kept logs live: IndexedDB on the phone, memory in tests. */
export interface KeepStore {
  meta(): Promise<KeptMeta[]>
  read(sha256: string): Promise<Uint8Array | null>
  write(meta: KeptMeta, bytes: Uint8Array): Promise<void>
  touch(sha256: string, usedAt: number): Promise<void>
  remove(sha256: string): Promise<void>
  clear(): Promise<void>
}

export class LogKeep {
  private readonly store: KeepStore
  private readonly capBytes: number
  private readonly maxLogBytes: number
  private readonly now: () => number

  constructor(store: KeepStore, opts: { capBytes: number; maxLogBytes: number; now?: () => number }) {
    this.store = store
    this.capBytes = opts.capBytes
    this.maxLogBytes = opts.maxLogBytes
    this.now = opts.now ?? Date.now
  }

  /** A kept log's bytes (and it becomes the most recently opened), or null. */
  async get(sha256: string): Promise<Uint8Array | null> {
    try {
      const bytes = await this.store.read(sha256)
      if (bytes) await this.store.touch(sha256, this.now())
      return bytes
    } catch { return null }
  }

  /** Keep a log just opened, unless it is too big; then drop the least recently opened until the rest fit. */
  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > this.maxLogBytes || bytes.length > this.capBytes) return
    try {
      await this.store.write({ sha256, size: bytes.length, usedAt: this.now() }, bytes)
      const all = (await this.store.meta()).sort((a, b) => b.usedAt - a.usedAt)
      let total = 0
      for (const m of all) {
        total += m.size
        if (total > this.capBytes && m.sha256 !== sha256) { await this.store.remove(m.sha256); total -= m.size }
      }
    } catch { /* not kept: the next open downloads it */ }
  }

  async remove(sha256: string): Promise<void> { try { await this.store.remove(sha256) } catch { /* gone or never there */ } }

  /** The sha-256 of every kept log. */
  async kept(): Promise<string[]> { try { return (await this.store.meta()).map((m) => m.sha256) } catch { return [] } }

  async clear(): Promise<void> { try { await this.store.clear() } catch { /* nothing kept */ } }
}

export function memoryKeepStore(): KeepStore {
  const metas = new Map<string, KeptMeta>()
  const blobs = new Map<string, Uint8Array>()
  return {
    meta: async () => [...metas.values()],
    read: async (sha) => blobs.get(sha) ?? null,
    write: async (m, b) => { metas.set(m.sha256, m); blobs.set(m.sha256, b) },
    touch: async (sha, usedAt) => { const m = metas.get(sha); if (m) metas.set(sha, { ...m, usedAt }) },
    remove: async (sha) => { metas.delete(sha); blobs.delete(sha) },
    clear: async () => { metas.clear(); blobs.clear() },
  }
}

const META = 'meta'
const BYTES = 'bytes'

/** The phone's keep: two IndexedDB stores, the metadata (small, listed) and the bytes (Blobs, read one at a time). */
export function indexedDbKeepStore(dbName = 'hindsight-logs'): KeepStore {
  let opened: Promise<IDBDatabase> | null = null
  const open = () => (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(META, { keyPath: 'sha256' }); req.result.createObjectStore(BYTES) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('the kept-logs database is blocked'))
  }))
  const tx = async <T>(stores: string[], mode: IDBTransactionMode, act: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> => {
    const db = await open()
    return new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(stores, mode)
      const req = act(t)
      t.oncomplete = () => resolve(req ? req.result : undefined)
      t.onerror = t.onabort = () => reject(t.error)
    })
  }
  return {
    meta: async () => (await tx<KeptMeta[]>([META], 'readonly', (t) => t.objectStore(META).getAll())) ?? [],
    read: async (sha) => {
      const blob = await tx<Blob | undefined>([BYTES], 'readonly', (t) => t.objectStore(BYTES).get(sha))
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null
    },
    write: async (m, b) => { await tx([META, BYTES], 'readwrite', (t) => { t.objectStore(BYTES).put(new Blob([b as BlobPart]), m.sha256); t.objectStore(META).put(m) }) },
    touch: async (sha, usedAt) => {
      await tx([META], 'readwrite', (t) => {
        const s = t.objectStore(META)
        const r = s.get(sha)
        r.onsuccess = () => { if (r.result) s.put({ ...(r.result as KeptMeta), usedAt }) }
      })
    },
    remove: async (sha) => { await tx([META, BYTES], 'readwrite', (t) => { t.objectStore(META).delete(sha); t.objectStore(BYTES).delete(sha) }) },
    clear: async () => { await tx([META, BYTES], 'readwrite', (t) => { t.objectStore(META).clear(); t.objectStore(BYTES).clear() }) },
  }
}
