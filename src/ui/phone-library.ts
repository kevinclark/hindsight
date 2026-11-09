/** What the phone's Library list shows (src/ui/PhoneLibrary.svelte): labels, the event filter, days. Pure, tested. */
import type { Entry } from '../hub/catalog.ts'
import { dayText } from '../hub/layout.ts'
import type { LogRecord } from '../hub/types.ts'

/** The filter value for logs with no event name. */
export const NO_EVENT = '\u0000none'

/** Above this a log opened on an iPhone 17 Pro (the team's p99 log size, 275 MB); older phones are not measured. */
export const LARGE_BYTES = 275 * 2 ** 20
export const isLarge = (bytes: number): boolean => bytes > LARGE_BYTES

export function logLabel(r: Pick<LogRecord, 'matchType' | 'matchNumber' | 'onField'>): string {
  if (r.matchNumber !== null && r.matchType === 2) return `Q${r.matchNumber}`
  if (r.matchNumber !== null && r.matchType === 3) return `Playoff ${r.matchNumber}`
  if (r.matchNumber !== null && r.matchType === 1) return `Practice ${r.matchNumber}`
  return r.onField ? 'On the field' : 'Off the field'
}

/** '' keeps every log; NO_EVENT those with no event name; otherwise that event's. */
export function filterByEvent(entries: Entry[], event: string): Entry[] {
  return entries.filter((e) => event === '' || (event === NO_EVENT ? !e.record.event : e.record.event === event))
}

/** Consecutive logs of one day together, in the order given (newest first from the hub; undated logs come last). */
export function byDay(entries: Entry[]): { day: string; logs: Entry[] }[] {
  const out: { day: string; logs: Entry[] }[] = []
  for (const e of entries) {
    const day = e.record.playedAt === null ? 'No date' : dayText(e.record.playedAt)
    const last = out.at(-1)
    if (last?.day === day) last.logs.push(e); else out.push({ day, logs: [e] })
  }
  return out
}

/** Only the logs kept on this phone (the log and its DS logs all kept): what opens with no download, and offline. */
export function onThisPhone(entries: Entry[], kept: ReadonlySet<string>): Entry[] {
  return entries.filter((e) => [e.record, ...e.attached.dslog, ...e.attached.dsevents].every((r) => kept.has(r.sha256)))
}
