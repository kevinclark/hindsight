/**
 * Read the library's own copies of its robot logs again with the current describer, and write down what changed as `meta`
 * records (the manifest is append-only; the catalog lays the latest one over the log record). Never touches a log file.
 * A reading never changes what decides a file's path or identity (`kind`, `playedAt`, `dateSource`): those stay as ingest
 * filed them.
 */
import { isDeepStrictEqual } from 'node:util'
import type { Described } from './describe-file.ts'
import type { LocalLibrary } from './library-store.ts'
import type { LogMeta } from './types.ts'

export interface RedescribeReport {
  wpilogs: number
  changed: number
  unchanged: number
  /** Recorded in the library but not on this computer. */
  missing: number
  failed: { path: string; reason: string }[]
}

export interface RedescribeOptions {
  describe(path: string, name: string): Promise<Described>
  cancelled?(): boolean
  onProgress?(done: number, total: number, current: string): void
}

const FIXED = new Set(['kind', 'playedAt', 'dateSource'])

/** Every describable field of a reading: all but the ones that decide where the file lives. */
export function describable(meta: LogMeta): Partial<LogMeta> {
  return Object.fromEntries(Object.entries(meta).filter(([k]) => !FIXED.has(k))) as Partial<LogMeta>
}

export async function redescribe(lib: LocalLibrary, options: RedescribeOptions): Promise<RedescribeReport> {
  const records = lib.catalog.all().filter((r) => r.kind === 'wpilog').sort((a, b) => a.path.localeCompare(b.path))
  const report: RedescribeReport = { wpilogs: records.length, changed: 0, unchanged: 0, missing: 0, failed: [] }
  let done = 0
  for (const r of records) {
    if (options.cancelled?.()) break
    options.onProgress?.(done++, records.length, r.path.split('/').pop() ?? r.path)
    if ((await lib.store.stat(r.path)) === null) { report.missing++; continue }
    try {
      const read = await options.describe(lib.store.at(r.path), r.names[0] ?? r.path.split('/').pop()!)
      if (read.sha256 !== r.sha256) { report.failed.push({ path: r.path, reason: 'the file on disk is not the one the library recorded (its sha-256 differs)' }); continue }
      const meta = describable(read.meta)
      if (Object.entries(meta).every(([k, v]) => isDeepStrictEqual(v, (r as unknown as Record<string, unknown>)[k]))) report.unchanged++
      else {
        // The whole reading, not only the differences: the catalog keeps the latest meta record per log, whole.
        await lib.append({ type: 'meta', sha256: r.sha256, meta, recordedAt: Date.now(), machine: lib.machine })
        report.changed++
      }
    } catch (e) {
      report.failed.push({ path: r.path, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  options.onProgress?.(records.length, records.length, '')
  return report
}
