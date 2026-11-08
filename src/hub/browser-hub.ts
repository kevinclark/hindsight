/**
 * The hub as the phone has it: read-only, straight from the team's Drive folder. It reads two kinds of file, each laptop's
 * `history/<machine>.jsonl` (triage marks) and `events/<key>--<machine>.jsonl` (match summaries), through a cache that
 * fetches only what grew. It never lists or reads `manifests/` (2 MB) and has no method that writes.
 *
 * No `node:` imports.
 */
import type { FileInfo } from './adapter.ts'
import { foldEvent, isEventKey, parseEventPath, type FoldedLine } from './event-file.ts'
import { readAppendOnly, type ReadStore, type TextCache } from './phone-cache.ts'
import { mergeHistory, parseHistory, serializeHistory, type HistoryEvent } from '../triage/history.ts'

export interface BrowserHubOptions {
  store: ReadStore
  cache: TextCache
  /** The app version, shown on the phone. */
  version: string
  now?: () => number
}

export interface EventView {
  key: string
  logs: FoldedLine[]
  skipped: number
  laptops: { machine: string; modifiedTime: number | null; lines: number }[]
}

const isHistoryFile = (f: FileInfo) => /^history\/[A-Za-z0-9_-]+\.jsonl$/.test(f.path)

export class BrowserHub {
  readonly readOnly = true as const
  private readonly store: ReadStore
  private readonly cache: TextCache
  private readonly version: string
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readAt: number | null = null
  private newestFile: number | null = null

  constructor(opts: BrowserHubOptions) {
    this.store = opts.store
    this.cache = opts.cache
    this.version = opts.version
    this.now = opts.now ?? Date.now
  }

  async info(): Promise<{ version: string; readOnly: true }> {
    return { version: this.version, readOnly: true }
  }

  async event(key: string): Promise<EventView> {
    if (!isEventKey(key)) throw new Error(`not an event key: ${JSON.stringify(key)}`)
    const files = (await this.listed('events')).filter((f) => parseEventPath(f.path)?.key === key)
    const read: { machine: string; text: string; info: FileInfo }[] = []
    for (const info of files) read.push({ machine: parseEventPath(info.path)!.machine, text: (await readAppendOnly(this.store, info, this.cache)).text, info })
    const folded = foldEvent(read)
    const logs = [...folded.logs.values()].sort((a, b) => {
      const x = a.line.summary.playedAt, y = b.line.summary.playedAt
      if (x !== y) { if (x === null) return 1; if (y === null) return -1; return x - y }
      return a.line.summary.fileName.localeCompare(b.line.summary.fileName)
    })
    const laptops = read.map((r) => ({ machine: r.machine, modifiedTime: r.info.modifiedTime, lines: r.text.split('\n').filter((l) => l.trim() !== '').length }))
    return { key, logs, skipped: folded.skipped, laptops }
  }

  /** The events the laptops have published, the one pushed to most recently first. */
  async eventKeys(): Promise<{ key: string; newest: number | null }[]> {
    const by = new Map<string, number | null>()
    for (const f of await this.listed('events')) {
      const key = parseEventPath(f.path)?.key
      if (!key) continue
      const was = by.get(key) ?? null
      by.set(key, was === null || (f.modifiedTime !== null && f.modifiedTime > was) ? f.modifiedTime : was)
    }
    return [...by].map(([key, newest]) => ({ key, newest })).sort((a, b) => (b.newest ?? 0) - (a.newest ?? 0))
  }

  /** Every laptop's triage marks merged, as the text a laptop's own `hub.history()` gives. */
  async history(): Promise<string> {
    const files = (await this.listed('history')).filter(isHistoryFile)
    let events: HistoryEvent[] = []
    for (const info of files) events = mergeHistory(events, parseHistory((await readAppendOnly(this.store, info, this.cache)).text).events)
    return serializeHistory(events)
  }

  /** Whether any history file or this event's files differ from what was last read; tells the listeners if so. Reads no file. */
  async check(key: string): Promise<boolean> {
    if (!isEventKey(key)) throw new Error(`not an event key: ${JSON.stringify(key)}`)
    const files = [...(await this.listed('history')).filter(isHistoryFile), ...(await this.listed('events')).filter((f) => parseEventPath(f.path)?.key === key)]
    let changed = false
    for (const f of files) {
      const kept = await this.cache.get(f.path)
      if (!kept || (f.sha256 ? f.sha256 !== kept.sha256 : f.size !== kept.size)) changed = true
    }
    if (changed) for (const cb of [...this.listeners]) cb()
    return changed
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** When this hub last read Drive, and when any laptop last pushed a history or event file (the newest modified time seen). */
  freshness(): { readAt: number | null; newestFile: number | null } {
    return { readAt: this.readAt, newestFile: this.newestFile }
  }

  /** Check now and then, and when the page comes back to the front. A failed check (offline) is ignored: freshness keeps the last good read. */
  watch(key: string, opts: { everyMs?: number } = {}): () => void {
    const run = () => { this.check(key).catch(() => {}) }
    const timer = setInterval(run, opts.everyMs ?? 60_000)
    const onVisible = () => { if (document.visibilityState === 'visible') run() }
    const hasDocument = typeof document !== 'undefined'
    if (hasDocument) document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      if (hasDocument) document.removeEventListener('visibilitychange', onVisible)
    }
  }

  /** A listing of `events` or `history`, which also moves the freshness marks. */
  private async listed(prefix: 'events' | 'history'): Promise<FileInfo[]> {
    const files = await this.store.list(prefix)
    this.readAt = this.now()
    for (const f of files) if (f.modifiedTime !== null && (this.newestFile === null || f.modifiedTime > this.newestFile)) this.newestFile = f.modifiedTime
    return files
  }
}
