/**
 * Read the library's own copies of its robot logs again with the current describer, and write down what changed as `meta`
 * records (the manifest is append-only; the catalog lays the latest one over the log record). Never touches a log file.
 * A reading never changes what decides a file's path or identity (`kind`, `playedAt`, `dateSource`): those stay as ingest
 * filed them.
 */
import { isDeepStrictEqual } from 'node:util'
import type { Described } from './describe-file.ts'
import type { LocalLibrary } from './library-store.ts'
import { newerVersion } from './catalog.ts'
import { DESCRIBABLE_KEYS, type LogMeta, type LogRecord } from './types.ts'

export interface RedescribeReport {
  wpilogs: number
  changed: number
  unchanged: number
  /** Already read by this build of the describer, or by a newer app version (the log's latest meta carries its id): not read again. */
  skipped: number
  /** Recorded in the library but not on this computer. */
  missing: number
  failed: { path: string; reason: string }[]
}

export interface RedescribeOptions {
  /** This build's describer id, written on every record and compared with the latest meta of each log. */
  describer: string
  describe(path: string, name: string): Promise<Described>
  cancelled?(): boolean
  onProgress?(done: number, total: number, current: string): void
}

/** Every describable field of a reading from the describer: all but the ones that decide where the file lives. */
export function describable(meta: LogMeta): Partial<LogMeta> {
  return Object.fromEntries(DESCRIBABLE_KEYS.filter((k) => k in meta && meta[k] !== undefined).map((k) => [k, meta[k]])) as Partial<LogMeta>
}

/** What a log record shows of a reading (no path, hashes or names), as a `meta` record carries it, `code` included. */
export function readingOf(r: LogRecord): Partial<LogMeta> {
  return describable(r)
}

export async function redescribe(lib: LocalLibrary, options: RedescribeOptions): Promise<RedescribeReport> {
  const records = lib.catalog.all().filter((r) => r.kind === 'wpilog').sort((a, b) => a.path.localeCompare(b.path))
  const report: RedescribeReport = { wpilogs: records.length, changed: 0, unchanged: 0, skipped: 0, missing: 0, failed: [] }
  let done = 0
  for (const r of records) {
    if (options.cancelled?.()) break
    options.onProgress?.(done++, records.length, r.path.split('/').pop() ?? r.path)
    // Already read by this build, or by a newer app version (an older one must not overwrite what a newer one found).
    const latest = lib.catalog.metaOf(r.sha256)?.describer
    if (options.describer && latest && (latest === options.describer || newerVersion(latest, options.describer))) { report.skipped++; continue }
    if ((await lib.store.stat(r.path)) === null) { report.missing++; continue }
    try {
      const read = await options.describe(lib.store.at(r.path), r.names[0] ?? r.path.split('/').pop()!)
      if (read.sha256 !== r.sha256) { report.failed.push({ path: r.path, reason: 'the file on disk is not the one the library recorded (its sha-256 differs)' }); continue }
      const meta = describable(read.meta)
      const same = Object.entries(meta).every(([k, v]) => isDeepStrictEqual(v, (r as unknown as Record<string, unknown>)[k]))
      // The whole reading, not only the differences: the catalog keeps the latest meta record per log, whole. A code link
      // is not something reading a log can find, so it is carried over from what the library shows now.
      const whole = r.code ? { ...meta, code: r.code } : meta
      // Unchanged logs get a record too, so that the next run knows this build has read them and skips them.
      await lib.append({ type: 'meta', sha256: r.sha256, meta: whole, describer: options.describer, recordedAt: Date.now(), machine: lib.machine })
      if (same) report.unchanged++; else report.changed++
    } catch (e) {
      report.failed.push({ path: r.path, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  options.onProgress?.(records.length, records.length, '')
  return report
}
