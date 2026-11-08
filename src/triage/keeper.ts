/**
 * Where a page's new triage lines go: the desktop app's library (only lines it lacks), else this browser's store. A read-only
 * page (the phone) writes nowhere: it shows the team's marks and changes none, so a mark can't look saved on a phone and
 * never reach the team. The gate is here, in the write path, not only in which buttons are drawn. No `node:` imports.
 */
import { serializeHistory, type HistoryEvent } from './history.ts'

export interface KeepTo {
  readOnly: boolean
  /** The desktop app's library: these lines appended to this laptop's history file. */
  append?(lines: string): void
  /** The page with no library: the whole history kept in this browser. */
  store?(text: string): void
}

/** The history after `events` is kept, and whether anything was written. Read only: the history as it was, nothing written. */
export function keepHistory(history: HistoryEvent[], events: HistoryEvent[], to: KeepTo): { history: HistoryEvent[]; wrote: boolean } {
  if (to.readOnly) return { history, wrote: false }
  if (to.append) {
    const had = new Set(history.map((e) => serializeHistory([e])))
    const fresh = events.filter((e) => !had.has(serializeHistory([e])))
    if (fresh.length) to.append(serializeHistory(fresh))
    return { history: events, wrote: fresh.length > 0 }
  }
  to.store?.(serializeHistory(events))
  return { history: events, wrote: true }
}
