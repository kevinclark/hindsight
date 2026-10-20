/**
 * Session summaries kept in this browser (IndexedDB), so a page reload doesn't mean choosing the folder again.
 * Only summaries are kept, never the logs. Each is keyed by the file's name, size and modified time, and stamped with
 * the build of this page's source (a hash of src/), the shape of the summary and the Hindsight version. Changed code
 * may read logs differently, so a summary from another build is never reused as if it were current; it is kept, and
 * shown as read with an older Hindsight while its shape is still one this page can draw (see stale.ts). Every call is
 * wrapped: a private window or blocked storage just means nothing is cached. Browsers treat every file:// page as one
 * site, so two different builds of this page opened from disk share the store.
 */
import { SUMMARY_SHAPE, type MatchSummary } from './summary.ts'
import { splitSaved, type SavedSummary, type SplitSaved } from './stale.ts'
import { VERSION } from '../version.ts'

declare const __BUILD_ID__: string
const BUILD = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev'
const DB = 'hindsight'
const STORE = 'summaries'

export type CachedSummary = SavedSummary

/** The key for one log file: its name, size and modified time. */
export function fileKey(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}|${file.size}|${file.lastModified}`
}

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'key' }) }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  return open().then((db) => new Promise((resolve) => {
    if (!db) return resolve(null)
    try {
      const tx = db.transaction(STORE, mode)
      const req = body(tx.objectStore(STORE))
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : null) }
      tx.onerror = () => { db.close(); resolve(null) }
      tx.onabort = () => { db.close(); resolve(null) }
    } catch { db.close(); resolve(null) }
  }))
}

/** Every saved summary, sorted into this build's, older builds' that can still be shown, and ones that can't. Nothing is deleted. */
export async function loadCached(): Promise<SplitSaved> {
  const all = (await run<CachedSummary[]>('readonly', (s) => s.getAll())) ?? []
  return splitSaved(all, BUILD, SUMMARY_SHAPE)
}

/** Save one log's summary, replacing any saved for an older copy of the same file name (re-downloaded, changed). */
export async function saveCached(key: string, summary: MatchSummary): Promise<boolean> {
  const all = (await run<CachedSummary[]>('readonly', (s) => s.getAll())) ?? []
  const older = all.filter((c) => c.summary.fileName === summary.fileName && c.key !== key)
  const done = await run('readwrite', (s) => {
    for (const c of older) s.delete(c.key)
    return s.put({ key, build: BUILD, shape: SUMMARY_SHAPE, version: VERSION, savedAt: new Date().toISOString(), summary } satisfies CachedSummary)
  })
  return done !== null
}

export async function clearCached(): Promise<void> {
  await run('readwrite', (s) => s.clear())
}
