/**
 * The hub as the phone has it: read-only, straight from the team's Drive folder. For the event it reads each laptop's
 * `history/<machine>.jsonl` (triage marks) and `events/<key>--<machine>.jsonl` (match summaries) through a cache that
 * fetches only what grew. Its Library reads the laptops' `manifests/` (about 2 MB each, the same cache) only when asked,
 * and opens a log by downloading it whole through `media` (or reading it from `keep`, the logs kept on this phone). It has no method that writes.
 *
 * No `node:` imports.
 */
import type { FileInfo } from './adapter.ts'
import { Catalog, type Entry } from './catalog.ts'
import { baseName } from './layout.ts'
import { sha256Hex } from './phone-cache.ts'
import type { LogKeep } from './log-keep.ts'
import { foldEvent, isEventKey, parseEventPath, type FoldedLine } from './event-file.ts'
import { readAppendOnly, type ReadStore, type TextCache } from './phone-cache.ts'
import { mergeHistory, parseHistory, serializeHistory, type HistoryEvent } from '../triage/history.ts'

export interface BrowserHubOptions {
  store: ReadStore
  cache: TextCache
  /** The app version, shown on the phone. */
  version: string
  /** Where log bytes come from (the iPhone app: Drive through the WebView's own fetch, never the base64 bridge). Without it no log opens. */
  /** Logs kept on the phone after opening (src/hub/log-keep.ts): reopening one reads no Drive bytes. */
  keep?: LogKeep
  media?: { downloadWhole(path: string, opts?: { onProgress?(got: number, total: number): void; signal?: AbortSignal; log?(line: string): void }): Promise<Uint8Array> }
  now?: () => number
}

export interface EventView {
  key: string
  logs: FoldedLine[]
  skipped: number
  laptops: { machine: string; modifiedTime: number | null; lines: number }[]
}

const isHistoryFile = (f: FileInfo) => /^history\/[A-Za-z0-9_-]+\.jsonl$/.test(f.path)
const isManifest = (f: FileInfo) => /^manifests\/[A-Za-z0-9_-]+\.jsonl$/.test(f.path)

export interface OpenedFile { name: string; bytes: Uint8Array }

export class BrowserHub {
  readonly readOnly = true as const
  private readonly store: ReadStore
  private readonly media: BrowserHubOptions['media']
  private readonly keep: LogKeep | undefined
  /**
   * The keep's writes, one after another. Every keep operation and the next open wait for it, so Clear or Sign out never
   * races a write (a cleared log came back), the cap holds, and the log being stored is let go before the next downloads.
   */
  private pending: Promise<void> = Promise.resolve()
  private readonly cache: TextCache
  private readonly version: string
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readAt: number | null = null
  private newestFile: number | null = null

  constructor(opts: BrowserHubOptions) {
    this.store = opts.store
    this.media = opts.media
    this.keep = opts.keep
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

  /** Every robot log the laptops' manifests list, with the DS logs and hoot files that belong to it, newest first. */
  async logs(): Promise<Entry[]> {
    const texts: string[] = []
    for (const info of (await this.store.list('manifests')).filter(isManifest)) texts.push((await readAppendOnly(this.store, info, this.cache)).text)
    return Catalog.from(texts).entries().sort((a, b) => (b.record.playedAt ?? -Infinity) - (a.record.playedAt ?? -Infinity))
  }

  /** A log and its DS logs, each read from the keep or downloaded whole, and checked against the sha-256 the manifest gives; a download within the keep's limits is kept for the next open. */
  async openLog(entry: Pick<Entry, 'record' | 'attached'>, opts: { onProgress?(got: number, total: number): void; signal?: AbortSignal; log?(line: string): void } = {}): Promise<OpenedFile[]> {
    if (!this.media) throw new Error('This phone cannot open logs.')
    if (this.keep) { opts.log?.('waiting for the last log to be stored'); await this.pending }
    const records = [entry.record, ...entry.attached.dslog, ...entry.attached.dsevents]
    const total = records.reduce((n, r) => n + r.size, 0)
    const out: OpenedFile[] = []
    let before = 0
    for (const r of records) {
      let bytes = await this.keep?.get(r.sha256) ?? null
      if (bytes && (await sha256Hex(bytes)) !== r.sha256) { opts.log?.(`${baseName(r.path)}: kept copy damaged, downloading`); await this.keep?.remove(r.sha256); bytes = null }
      if (bytes) opts.log?.(`${baseName(r.path)}: kept on this phone`)
      else {
        opts.log?.(`${baseName(r.path)}: downloading ${r.size} bytes`)
        bytes = await this.media.downloadWhole(r.path, { signal: opts.signal, onProgress: (got) => opts.onProgress?.(before + got, total), log: opts.log })
        opts.log?.(`${baseName(r.path)}: checking sha-256`)
        if ((await sha256Hex(bytes)) !== r.sha256) throw new Error(`${baseName(r.path)} on the team Drive is not the log the team's list names (its checksum differs).`)
        // Not awaited here: Match review need not wait for the storage write (put swallows its own failures).
        const keep = this.keep, sha = r.sha256, kept = bytes
        if (keep) this.pending = this.pending.then(() => keep.put(sha, kept))
      }
      opts.onProgress?.(before + r.size, total)
      out.push({ name: baseName(r.path), bytes })
      before += r.size
    }
    return out
  }

  /** How many bytes of logs are kept on this phone. */
  async keptBytes(): Promise<number> { await this.pending; return (await this.keep?.used()) ?? 0 }
  /** A new size for the kept logs: the least recently opened go at once until the rest fit. */
  async setKeepCap(bytes: number): Promise<void> { await this.pending; await this.keep?.setCap(bytes) }
  /** Forget every kept log. */
  async clearKept(): Promise<void> { await this.pending; await this.keep?.clear() }

  /** The sha-256 of every log kept on this phone (the Library marks them). */
  async keptLogs(): Promise<Set<string>> { await this.pending; return new Set((await this.keep?.kept()) ?? []) }

  /** A listing of `events` or `history`, which also moves the freshness marks. */
  private async listed(prefix: 'events' | 'history'): Promise<FileInfo[]> {
    const files = await this.store.list(prefix)
    this.readAt = this.now()
    for (const f of files) if (f.modifiedTime !== null && (this.newestFile === null || f.modifiedTime > this.newestFile)) this.newestFile = f.modifiedTime
    return files
  }
}
