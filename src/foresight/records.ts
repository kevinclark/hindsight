/**
 * Foresight's rolling record of the robot's signals: every value received since connecting (or, for the backtest,
 * read from a match log), by log key, kept as .wpilog payloads.
 *
 * `windowLog(from, to)` writes the stretch [from, to] as a .wpilog: each signal's value held at `from` becomes a
 * record at `from`, then every record after it up to `to`. The rules then see only that stretch, as if the log had
 * started there: camera alerts from start-up that cleared before it never reach them.
 */
import { readRaw, type WpilogFile } from '../readers/wpilog.ts'
import { writeRecords, type RecordEntry } from '../readers/wpilog-writer.ts'

/** Records older than this many seconds are dropped (the last one before the cut is kept as the held value). */
export const KEEP_SECONDS = 15 * 60

export class RecordStore {
  readonly entries = new Map<string, RecordEntry>()
  /** The latest record time seen on any signal: "now" in robot time. */
  latest = -Infinity

  /** Add one record. Records that arrive out of order are put in place. */
  add(name: string, type: string, t: number, payload: Uint8Array): void {
    let e = this.entries.get(name)
    if (!e) { e = { name, type, t: [], payload: [] }; this.entries.set(name, e) }
    if (e.type !== type) return // a topic re-announced with another type: keep the first, as the reader does
    let i = e.t.length
    while (i > 0 && e.t[i - 1] > t) i--
    e.t.splice(i, 0, t)
    e.payload.splice(i, 0, payload)
    if (t > this.latest) this.latest = t
  }

  /** Make sure a signal exists even before its first value (so "announced but never sent" is visible). */
  declare(name: string, type: string): void {
    if (!this.entries.has(name)) this.entries.set(name, { name, type, t: [], payload: [] })
  }

  /** Drop records older than KEEP_SECONDS before the latest, keeping each signal's held value. */
  prune(): void {
    const cut = this.latest - KEEP_SECONDS
    for (const e of this.entries.values()) {
      let k = 0
      while (k + 1 < e.t.length && e.t[k + 1] <= cut) k++
      if (k > 0) { e.t.splice(0, k); e.payload.splice(0, k) }
    }
  }

  /** The stretch [from, to] as a .wpilog (see the top of this file). */
  windowLog(from: number, to: number): Uint8Array {
    const out: RecordEntry[] = []
    for (const e of this.entries.values()) {
      const t: number[] = []
      const payload: Uint8Array[] = []
      let held = -1
      for (let i = 0; i < e.t.length && e.t[i] <= to; i++) {
        if (e.t[i] <= from) { held = i; continue }
        t.push(e.t[i]); payload.push(e.payload[i])
      }
      if (held >= 0) { t.unshift(from); payload.unshift(e.payload[held]) }
      out.push({ name: e.name, type: e.type, metadata: e.metadata, t, payload })
    }
    return writeRecords(out)
  }

  /** A store holding these keys of a log (all of them if `keys` is null). */
  static fromWpilog(log: WpilogFile, keys: Iterable<string> | null): RecordStore {
    const store = new RecordStore()
    for (const name of keys ?? log.entries.keys()) {
      const raw = readRaw(log, name)
      if (!raw) continue
      store.entries.set(name, { name, type: raw.entry.type, metadata: raw.entry.metadata, t: raw.t, payload: raw.payload })
      // File order is time order except for the odd pre-sync record; sort to be safe.
      const e = store.entries.get(name)!
      if (e.t.some((x, i) => i > 0 && x < e.t[i - 1])) {
        const order = e.t.map((_, i) => i).sort((a, b) => e.t[a] - e.t[b] || a - b)
        e.t = order.map((i) => raw.t[i]); e.payload = order.map((i) => raw.payload[i])
      }
      if (e.t.length && e.t[e.t.length - 1] > store.latest) store.latest = e.t[e.t.length - 1]
    }
    return store
  }
}
