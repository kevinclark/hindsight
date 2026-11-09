/**
 * Logs the phone keeps after opening them, so opening one again reads no Drive bytes; big logs most of all. Keyed by the
 * log's sha-256; up to a cap the person sets (src/phone/keep-setting.ts, 1 GB to start), the least recently opened dropped
 * first. Stored in IndexedDB in pieces of a few MB, each written and let go in turn, so keeping a 641 MB log never holds a
 * second whole copy in memory (a single Blob would). Apart from the text cache (src/hub/phone-cache.ts). Every failure
 * (private storage, quota, a blocked database) behaves as an empty keep: the phone downloads again.
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
  private capBytes: number
  private readonly now: () => number

  constructor(store: KeepStore, opts: { capBytes: number; now?: () => number }) {
    this.store = store
    this.capBytes = opts.capBytes
    this.now = opts.now ?? Date.now
  }

  /** A new cap: the least recently opened go at once until the rest fit (0 keeps nothing). */
  async setCap(capBytes: number): Promise<void> {
    this.capBytes = capBytes
    try {
      const all = (await this.store.meta()).sort((a, b) => a.usedAt - b.usedAt)
      let total = all.reduce((n, m) => n + m.size, 0)
      while (all.length && total > capBytes) { const old = all.shift()!; await this.store.remove(old.sha256); total -= old.size }
    } catch { /* what could not be dropped stays until the next put */ }
  }

  /** Bytes kept now. */
  async used(): Promise<number> { try { return (await this.store.meta()).reduce((n, m) => n + m.size, 0) } catch { return 0 } }

  /** A kept log's bytes (and it becomes the most recently opened), or null. */
  async get(sha256: string): Promise<Uint8Array | null> {
    try {
      const bytes = await this.store.read(sha256)
      if (bytes) await this.store.touch(sha256, this.now())
      return bytes
    } catch { return null }
  }

  /**
   * Keep a log just opened, unless it is bigger than the cap: first drop the least recently opened until it fits under the cap, then
   * write it; a refused write (a full quota) drops the oldest once more and tries again.
   */
  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length === 0 || bytes.length > this.capBytes) return
    const meta = { sha256, size: bytes.length, usedAt: this.now() }
    try {
      const others = (await this.store.meta()).filter((m) => m.sha256 !== sha256).sort((a, b) => a.usedAt - b.usedAt)
      let total = others.reduce((n, m) => n + m.size, 0)
      while (others.length && total + bytes.length > this.capBytes) { const old = others.shift()!; await this.store.remove(old.sha256); total -= old.size }
      try { await this.store.write(meta, bytes) } catch {
        const old = others.shift()
        if (!old) return
        await this.store.remove(old.sha256)
        await this.store.write(meta, bytes)
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
const PIECES = 'pieces'
/** A kept log is stored in pieces of this size. */
export const KEEP_PIECE_BYTES = 8 << 20
const pieceKey = (sha256: string, i: number) => `${sha256}#${String(i).padStart(6, '0')}`
const piecesOf = (sha256: string) => IDBKeyRange.bound(`${sha256}#`, `${sha256}#\uffff`)

/** The phone's keep: the metadata (small, listed) and each log's pieces (Blobs, written and read one at a time). */
export function indexedDbKeepStore(dbName = 'hindsight-logs', pieceBytes = KEEP_PIECE_BYTES): KeepStore {
  let opened: Promise<IDBDatabase> | null = null
  // A failed open is not remembered: the next call tries again (a blocked open can clear).
  const open = () => (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      // Version 1 kept each log as one Blob: those go (the phone downloads them again).
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name)
      db.createObjectStore(META, { keyPath: 'sha256' })
      db.createObjectStore(PIECES)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('the kept-logs database is blocked'))
  }).catch((e) => { opened = null; throw e }))
  const tx = async <T>(stores: string[], mode: IDBTransactionMode, act: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> => {
    const db = await open()
    return new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(stores, mode)
      const req = act(t)
      t.oncomplete = () => resolve(req ? req.result : undefined)
      t.onerror = t.onabort = () => reject(t.error)
    })
  }
  const removeAll = (sha: string) => tx([META, PIECES], 'readwrite', (t) => { t.objectStore(META).delete(sha); t.objectStore(PIECES).delete(piecesOf(sha)) })
  return {
    meta: async () => (await tx<KeptMeta[]>([META], 'readonly', (t) => t.objectStore(META).getAll())) ?? [],
    read: async (sha) => {
      const m = await tx<KeptMeta | undefined>([META], 'readonly', (t) => t.objectStore(META).get(sha))
      if (!m) return null
      const out = new Uint8Array(m.size)
      for (let i = 0, at = 0; at < m.size; i++, at += pieceBytes) {
        const blob = await tx<Blob | undefined>([PIECES], 'readonly', (t) => t.objectStore(PIECES).get(pieceKey(sha, i)))
        if (!blob || blob.size !== Math.min(pieceBytes, m.size - at)) return null
        out.set(new Uint8Array(await blob.arrayBuffer()), at)
      }
      return out
    },
    // Piece by piece, then the metadata last: a log only half written is never listed (and is cleared on failure).
    write: async (m, b) => {
      try {
        for (let i = 0, at = 0; at < b.length; i++, at += pieceBytes) {
          const piece = new Blob([b.subarray(at, Math.min(at + pieceBytes, b.length)) as BlobPart])
          await tx([PIECES], 'readwrite', (t) => { t.objectStore(PIECES).put(piece, pieceKey(m.sha256, i)) })
        }
        await tx([META], 'readwrite', (t) => { t.objectStore(META).put(m) })
      } catch (e) { await removeAll(m.sha256).catch(() => {}); throw e }
    },
    touch: async (sha, usedAt) => {
      await tx([META], 'readwrite', (t) => {
        const s = t.objectStore(META)
        const r = s.get(sha)
        r.onsuccess = () => { if (r.result) s.put({ ...(r.result as KeptMeta), usedAt }) }
      })
    },
    remove: async (sha) => { await removeAll(sha) },
    clear: async () => { await tx([META, PIECES], 'readwrite', (t) => { t.objectStore(META).clear(); t.objectStore(PIECES).clear() }) },
  }
}
