/**
 * Nexus (frc.nexus) event API v1, read with the team's own API key, with a copy of the answer kept for offline use.
 * Same shape as the The Blue Alliance client (src/tba/source.ts) and the same stores. The key goes in one request
 * header and nowhere else: not in the store, an error message, or anything returned.
 */
import type { Fetched, TbaStore } from '../tba/source.ts'

const BASE = 'https://frc.nexus/api/v1'

/** A copy is good for a minute: Nexus recomputes its times live. */
export const NEXUS_TTL_MS = 60_000

/** Every time is Unix milliseconds (TBA's are seconds), and may be null or absent. */
export interface NexusMatchTimes {
  scheduledStartTime?: number | null
  estimatedQueueTime?: number | null
  estimatedOnDeckTime?: number | null
  estimatedOnFieldTime?: number | null
  estimatedStartTime?: number | null
  actualQueueTime?: number | null
  actualOnDeckTime?: number | null
  actualOnFieldTime?: number | null
  actualStartTime?: number | null
  actualCommitTime?: number | null
}

export interface NexusMatch {
  /** "Qualification 12", "Playoff 3", "Final 1", "Practice 2", "Qualification 2 Replay". */
  label: string
  status: string
  redTeams: string[]
  blueTeams: string[]
  replayOf: string | null
  breakAfter: string | null
  times: NexusMatchTimes
}

/** An event as Nexus answers it; matches are in play order. */
export interface NexusEvent {
  eventKey: string
  /** When Nexus computed this, ms since 1970. */
  dataAsOfTime: number
  nowQueuing: string | null
  matches: NexusMatch[]
  announcements: unknown[]
  partsRequests: unknown[]
}

/** Read an event. Throws a NexusError when there is no answer and no copy. */
export type NexusGet = (eventKey: string) => Promise<Fetched<NexusEvent>>

/** A plain-words failure; never carries the key or a request header. */
export class NexusError extends Error {
  status: number | null
  constructor(message: string, status: number | null = null) { super(message); this.name = 'NexusError'; this.status = status }
}

export const isNexusEventKey = (k: unknown): k is string => typeof k === 'string' && /^\d{4}[a-z0-9]{1,20}$/.test(k)

export function createNexus(opts: { key: string; store: TbaStore; fetch?: typeof fetch; now?: () => number }): NexusGet {
  const { key, store } = opts
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const now = opts.now ?? Date.now
  return async (eventKey: string): Promise<Fetched<NexusEvent>> => {
    if (!isNexusEventKey(eventKey)) throw new NexusError('Hindsight does not ask Nexus for that.')
    const path = `/event/${eventKey}`
    const copy = await store.read(path).catch(() => undefined)
    if (copy && now() - copy.at < NEXUS_TTL_MS) return { data: copy.data as NexusEvent, fetchedAt: copy.at, fromCache: true }
    try {
      const res = await doFetch(`${BASE}${path}`, { headers: { 'Nexus-Api-Key': key } })
      if (res.status === 401 || res.status === 403) throw new NexusError('Nexus did not accept the API key.', res.status)
      if (res.status === 404) throw new NexusError('This event is not on Nexus.', 404)
      if (!res.ok) throw new NexusError(`Nexus answered ${res.status}.`, res.status)
      const data = (await res.json()) as NexusEvent
      const at = now()
      await store.write(path, { at, data }).catch(() => {})
      return { data, fetchedAt: at, fromCache: false }
    } catch (e) {
      // A refused key or a missing event is an answer, not an outage: the copy would hide it.
      if (e instanceof NexusError && e.status !== null && e.status !== 429 && e.status < 500) throw e
      if (copy) return { data: copy.data as NexusEvent, fetchedAt: copy.at, fromCache: true }
      throw e instanceof NexusError ? e : new NexusError('Nexus could not be reached and there is no saved copy.')
    }
  }
}

/** Validate a Nexus API key from the page: undefined = not given, null = clear. Nexus's key format is not documented, so any 8-256 printable characters pass. */
export function checkNexusKey(key: unknown): string | null | undefined {
  if (key === undefined) return undefined
  if (key === null || (typeof key === 'string' && key.trim() === '')) return null
  if (typeof key !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(key.trim())) throw new Error('That does not look like a Nexus API key: copy it from frc.nexus/api.')
  return key.trim()
}
