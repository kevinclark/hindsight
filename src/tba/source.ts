/**
 * The Blue Alliance API v3, read with the team's own read key (ADR 6), with a copy of every answer kept for offline use.
 * Nothing here imports `node:` or the DOM: the page gives it a localStorage store, the desktop app's main process a file
 * in its data folder, and tests a map and a fake `fetch`. The key goes in one request header and nowhere else: not in
 * the cache, an error message, or anything a log summary, report or manifest could hold.
 */

const BASE = 'https://www.thebluealliance.com/api/v3'

/** An answer and when it was fetched (ms since 1970). `fromCache`: this call did not reach TBA (the copy was fresh enough, or TBA could not be reached). */
export interface Fetched<T> { data: T; fetchedAt: number; fromCache: boolean }
/** Read a TBA path ("/team/frc9999/events/2099/simple"). Throws a TbaError when there is no answer and no copy. */
export type TbaGet = <T>(path: string) => Promise<Fetched<T>>

export interface TbaStore {
  read(path: string): Promise<{ at: number; data: unknown } | undefined>
  write(path: string, entry: { at: number; data: unknown }): Promise<void>
}

/** A plain-words failure; never carries the key or a request header. */
export class TbaError extends Error {
  status: number | null
  constructor(message: string, status: number | null = null) { super(message); this.name = 'TbaError'; this.status = status }
}

/** The only three calls Hindsight makes. The desktop app's main process refuses any other path from the page. */
const PATHS = [
  /^\/team\/frc\d{1,5}\/events\/\d{4}\/simple$/,
  /^\/event\/\d{4}[a-z0-9]{1,20}$/,
  /^\/team\/frc\d{1,5}\/event\/\d{4}[a-z0-9]{1,20}\/matches\/simple$/,
]
export const isTbaPath = (p: unknown): p is string => typeof p === 'string' && PATHS.some((r) => r.test(p))

/** A team's schedule changes during an event; everything else about a past event does not. */
const MINUTE = 60e3
export const ttlOf = (path: string): number => (path.endsWith('/matches/simple') ? 10 * MINUTE : 24 * 60 * MINUTE)

export function createTba(opts: { key: string; store: TbaStore; fetch?: typeof fetch; now?: () => number }): TbaGet {
  const { key, store } = opts
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = opts.now ?? Date.now
  return async <T>(path: string): Promise<Fetched<T>> => {
    if (!isTbaPath(path)) throw new TbaError('Hindsight does not ask The Blue Alliance for that.')
    const copy = await store.read(path).catch(() => undefined)
    if (copy && now() - copy.at < ttlOf(path)) return { data: copy.data as T, fetchedAt: copy.at, fromCache: true }
    try {
      const res = await doFetch(`${BASE}${path}`, { headers: { 'X-TBA-Auth-Key': key } })
      if (res.status === 401 || res.status === 403) throw new TbaError('The Blue Alliance did not accept the read key.', res.status)
      if (!res.ok) throw new TbaError(`The Blue Alliance answered ${res.status}.`, res.status)
      const data = (await res.json()) as T
      const at = now()
      await store.write(path, { at, data }).catch(() => {})
      return { data, fetchedAt: at, fromCache: false }
    } catch (e) {
      // A refused key or a missing page is an answer, not an outage: the copy would hide it.
      if (e instanceof TbaError && e.status !== null && e.status !== 429 && e.status < 500) throw e
      if (copy) return { data: copy.data as T, fetchedAt: copy.at, fromCache: true }
      throw e instanceof TbaError ? e : new TbaError('The Blue Alliance could not be reached and there is no saved copy.')
    }
  }
}

/** A store in memory (tests). */
export function memoryStore(): TbaStore & { map: Map<string, { at: number; data: unknown }> } {
  const map = new Map<string, { at: number; data: unknown }>()
  return { map, read: async (p) => map.get(p), write: async (p, e) => { map.set(p, e) } }
}

/** A store in the page's localStorage, one item per path; every access guarded, so a page with no storage just has no copy. */
export function localStorageStore(prefix = 'hindsight.tba:'): TbaStore {
  return {
    async read(path) {
      try { return JSON.parse(localStorage.getItem(prefix + path) ?? 'null') ?? undefined } catch { return undefined }
    },
    async write(path, entry) {
      try { localStorage.setItem(prefix + path, JSON.stringify(entry)) } catch { /* full or blocked: no copy */ }
    },
  }
}
