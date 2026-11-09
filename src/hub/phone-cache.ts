/**
 * What the phone keeps between reads: the text of each append-only file, with the sha-256 Drive reported for it. A file one
 * laptop alone appends to only grows, so a changed file is usually the cached text plus a tail: the phone fetches just the
 * tail and checks the joined bytes against Drive's checksum before it believes them.
 *
 * No `node:` imports: the phone has WebCrypto's sha-256 (no md5) and IndexedDB, nothing else.
 */
import type { FileInfo } from './adapter.ts'

export interface CachedText {
  path: string
  /** Bytes (not characters): the offset where a tail read starts. */
  size: number
  sha256: string
  text: string
}

export interface TextCache {
  get(path: string): Promise<CachedText | null>
  put(entry: CachedText): Promise<void>
}

/** The three calls the phone makes on a store: DriveReader and MemoryAdapter both have them. */
export interface ReadStore {
  list(prefix: string): Promise<FileInfo[]>
  stat(path: string): Promise<FileInfo | null>
  read(path: string, start: number, end: number): Promise<Uint8Array>
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function memoryCache(): TextCache {
  const entries = new Map<string, CachedText>()
  return { get: async (path) => entries.get(path) ?? null, put: async (entry) => { entries.set(entry.path, entry) } }
}

const STORE = 'files'

/**
 * Kept in IndexedDB so a reload on a weak connection starts from the last read. Private browsing, a blocked or full
 * database all behave as an empty cache that keeps nothing: the phone then reads whole files, slower but right.
 */
export function indexedDbCache(dbName = 'hindsight-phone'): TextCache {
  let opened: Promise<IDBDatabase | null> | null = null
  const open = (): Promise<IDBDatabase | null> => {
    opened ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(dbName, 1)
        req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE, { keyPath: 'path' }) } catch { /* open fails below */ } }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch { resolve(null) }
    })
    return opened
  }
  const run = async <T>(mode: IDBTransactionMode, fallback: T, act: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    try {
      const db = await open()
      if (!db) return fallback
      return await new Promise<T>((resolve) => {
        try {
          const tx = db.transaction(STORE, mode)
          const req = act(tx.objectStore(STORE))
          tx.oncomplete = () => resolve((req.result as T | undefined) ?? fallback)
          tx.onerror = tx.onabort = () => resolve(fallback)
        } catch { resolve(fallback) }
      })
    } catch { return fallback }
  }
  return {
    get: (path) => run<CachedText | null>('readonly', null, (s) => s.get(path)),
    put: async (entry) => { await run<unknown>('readwrite', null, (s) => s.put(entry)) },
  }
}

/** Empty the phone's copies (on sign out). Clears the store rather than deleting the database, which an open page would block. */
export async function clearIndexedDbCache(dbName = 'hindsight-phone'): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.open(dbName, 1)
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE, { keyPath: 'path' }) } catch { /* cleared below or nothing kept */ } }
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction(STORE, 'readwrite')
          tx.objectStore(STORE).clear()
          tx.oncomplete = tx.onerror = tx.onabort = () => { req.result.close(); resolve() }
        } catch { resolve() }
      }
      req.onerror = req.onblocked = () => resolve()
    } catch { resolve() }
  })
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * The text of an append-only file, with as little read as is safe. (a) The cache holds this very content: no read.
 * (b) The cache holds a shorter start and the file grew: read only the new bytes and accept them if the whole then matches
 * Drive's sha-256. (c) Anything else (rewritten, no checksum to check a tail by): read the file whole.
 * Joined as bytes, decoded once, so a multibyte character can't be cut at the boundary.
 */
export async function readAppendOnly(store: ReadStore, info: FileInfo, cache: TextCache): Promise<{ text: string; how: 'cached' | 'tail' | 'whole' }> {
  const cached = await cache.get(info.path)
  if (cached && info.sha256 && info.sha256 === cached.sha256) return { text: cached.text, how: 'cached' }
  if (cached && info.sha256 && info.size > cached.size) {
    const head = enc.encode(cached.text)
    const tail = await store.read(info.path, cached.size, info.size)
    const joined = new Uint8Array(head.length + tail.length)
    joined.set(head, 0)
    joined.set(tail, head.length)
    const sha256 = await sha256Hex(joined)
    if (sha256 === info.sha256) {
      const text = dec.decode(joined)
      await cache.put({ path: info.path, size: joined.length, sha256, text })
      return { text, how: 'tail' }
    }
  }
  const bytes = info.size === 0 ? new Uint8Array(0) : await store.read(info.path, 0, info.size)
  const text = dec.decode(bytes)
  await cache.put({ path: info.path, size: bytes.length, sha256: await sha256Hex(bytes), text })
  return { text, how: 'whole' }
}
