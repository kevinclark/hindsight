/**
 * Nexus's live queue and start times, joined to the team's TBA schedule by match. Nothing here reads the clock or the network.
 */
import type { NexusEvent } from './source.ts'
import type { ScheduledMatch } from '../tba/schedule.ts'

export type NexusStatus = 'Queuing soon' | 'Now queuing' | 'On deck' | 'On field'
export interface NexusTimes {
  /** Estimated (or, once queuing has begun, actual) time the match is called to queue, ms since 1970. */
  queue: number | null
  /** Estimated start ("3-2-1-Go"), ms since 1970. */
  start: number | null
  status: NexusStatus | null
}

const STATUSES: readonly string[] = ['Queuing soon', 'Now queuing', 'On deck', 'On field']
const positive = (s: string | undefined): number | null => {
  const n = Number(s)
  return s !== undefined && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** TBA's match key (without the event) for a Nexus label; null for practice, replays and anything unknown. */
export function matchKeyOf(label: string): string | null {
  let m
  if ((m = /^Qualification (\d+)$/.exec(label))) { const n = positive(m[1]); return n ? `qm${n}` : null }
  if ((m = /^Playoff (\d+)$/.exec(label))) { const n = positive(m[1]); return n ? `sf${n}m1` : null }
  if ((m = /^Final (\d+)$/.exec(label))) { const n = positive(m[1]); return n ? `f1m${n}` : null }
  return null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Nexus's times by TBA match key. A replay is not the match it replays, so it is skipped. */
export function nexusTimes(ev: Pick<NexusEvent, 'matches'>): Map<string, NexusTimes> {
  const out = new Map<string, NexusTimes>()
  for (const m of ev.matches ?? []) {
    const key = matchKeyOf(m.label)
    if (!key || m.replayOf) continue
    const t = m.times ?? {}
    const times: NexusTimes = {
      queue: num(t.estimatedQueueTime) ?? num(t.actualQueueTime),
      start: num(t.actualStartTime) ?? num(t.estimatedStartTime),
      status: STATUSES.includes(m.status) ? (m.status as NexusStatus) : null,
    }
    // A row with no time and no call says nothing: leave The Blue Alliance's line (and no Nexus credit).
    if (times.queue !== null || times.start !== null || times.status !== null) out.set(key, times)
  }
  return out
}

/** The schedule with each match's Nexus times attached (null where Nexus has none). Same order. */
export function withNexus(schedule: readonly ScheduledMatch[], times: Map<string, NexusTimes> | null): ScheduledMatch[] {
  return schedule.map((m) => ({ ...m, nexus: times?.get(m.key.slice(m.key.lastIndexOf('_') + 1)) ?? null }))
}
