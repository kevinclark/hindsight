/**
 * Bring logs into the library from anywhere (a folder, a Drive folder, the robot). One file at a time:
 *  - identity is the content (sha-256), so the same bytes under two names are one log with both names remembered, and a
 *    file the library already holds is not read again when the source says its checksum;
 *  - each log is filed by what it says about itself (describe.ts), as a copy: the original is never touched;
 *  - a re-run of the same ingest finds everything already there and writes nothing.
 */
import { stat } from 'node:fs/promises'
import { LocalFolderAdapter, fileSource, hashFile } from './local-adapter.ts'
import type { Described } from './describe-file.ts'
import { libraryPath, withShaSuffix } from './layout.ts'
import type { LocalLibrary } from './library-store.ts'
import { kindOf, type AliasRecord, type LogRecord } from './types.ts'

export interface SourceFile {
  name: string
  /** Where it is, for the report (never written to a manifest). */
  where: string
  size: number
  modifiedTime: number | null
  from: LogRecord['from']
  /** The file's id in the store it came from (Drive), if it has one. */
  sourceId?: string
  /** Checksums the source already knows (a Drive listing's); with one of them matching the library the file is not downloaded. */
  sha256?: string
  md5?: string
  /** Make the bytes available as a file on this machine. A local source returns the original path; the original is only read. */
  open(): Promise<{ path: string; done(): Promise<void> }>
}

export interface ReportEntry { name: string; where: string }
export interface IngestReport {
  added: (ReportEntry & { path: string; size: number; undated: boolean; stub: boolean })[]
  /** Already in the library, with where it is filed and every name it has. `newName`: this name was new and is now remembered. */
  already: (ReportEntry & { path: string; names: string[]; newName: boolean })[]
  unreadable: (ReportEntry & { reason: string })[]
  /** Files seen that are not logs. */
  ignored: number
  bytesAdded: number
  durationMs: number
}

export interface IngestOptions {
  describe(path: string, name: string): Promise<Described>
  now?: () => number
  onProgress?(done: number, total: number, current: string): void
  /** Fingerprints of local files already read: "path|size|modified" → sha-256. A hit skips reading the file. */
  seen?: { get(key: string): string | undefined; set(key: string, sha256: string): void }
  /** Stop early (the user pressed cancel). */
  cancelled?: () => boolean
}

export async function ingest(lib: LocalLibrary, files: SourceFile[], options: IngestOptions): Promise<IngestReport> {
  const now = options.now ?? Date.now
  const started = now()
  const report: IngestReport = { added: [], already: [], unreadable: [], ignored: 0, bytesAdded: 0, durationMs: 0 }
  let done = 0
  for (const file of files) {
    options.onProgress?.(done++, files.length, file.name)
    if (options.cancelled?.()) break
    if (kindOf(file.name) === null) { report.ignored++; continue }
    try {
      await ingestOne(lib, file, options, report, now)
    } catch (e) {
      report.unreadable.push({ name: file.name, where: file.where, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  options.onProgress?.(files.length, files.length, '')
  report.durationMs = now() - started
  return report
}

async function ingestOne(lib: LocalLibrary, file: SourceFile, options: IngestOptions, report: IngestReport, now: () => number): Promise<void> {
  const fingerprint = `${file.where}|${file.size}|${file.modifiedTime}`
  // 1. Known without reading it: the source's own checksum, or a local file seen unchanged before.
  const knownSha = file.sha256 ?? options.seen?.get(fingerprint)
  const known = (knownSha ? lib.catalog.bySha(knownSha) : undefined) ?? (file.md5 ? lib.catalog.byMd5(file.md5) : undefined)
  if (known) return noteAlready(lib, file, known, report, now)

  const source = await file.open()
  try {
    // 2. Read it: hash and what it says about itself. A file that will not read is reported, not filed.
    const d = await options.describe(source.path, file.name)
    options.seen?.set(fingerprint, d.sha256)
    const again = lib.catalog.bySha(d.sha256)
    if (again) return noteAlready(lib, file, again, report, now)

    // 3. File a copy.
    const path = await freePath(lib.store, libraryPath(d.meta, file.name), d.sha256)
    if (!(await lib.store.stat(path))) {
      const from = await fileSource(source.path)
      try { await lib.store.writeNew(path, from, { sha256: d.sha256 }) } finally { await from.close() }
    }
    const record: LogRecord = {
      type: 'log', ...d.meta, sha256: d.sha256, md5: d.md5, size: d.size, path, names: [file.name],
      modifiedTime: file.modifiedTime, from: file.from, ...(file.sourceId ? { sourceId: file.sourceId } : {}), recordedAt: now(), machine: lib.machine,
    }
    await lib.append(record)
    report.added.push({ name: file.name, where: file.where, path, size: d.size, undated: d.meta.playedAt === null, stub: d.meta.stub })
    report.bytesAdded += d.size
  } finally {
    await source.done()
  }
}

/** The path to file under: the layout path if free; else with the content's first 8 digits added. A copy of this very content already there (a crash before its record was written) is reused. */
async function freePath(store: LocalFolderAdapter, path: string, sha256: string): Promise<string> {
  for (const candidate of [path, withShaSuffix(path, sha256)]) {
    if (!(await store.stat(candidate))) return candidate
    if ((await hashFile(store.at(candidate))).sha256 === sha256) return candidate
  }
  throw new Error(`${path} and ${withShaSuffix(path, sha256)} are both taken by other logs`)
}

async function noteAlready(lib: LocalLibrary, file: SourceFile, known: LogRecord, report: IngestReport, now: () => number): Promise<void> {
  const names = lib.catalog.namesOf(known.sha256)
  const newName = !names.includes(file.name)
  if (newName) {
    const alias: AliasRecord = { type: 'alias', sha256: known.sha256, name: file.name, recordedAt: now(), machine: lib.machine }
    await lib.append(alias)
  }
  report.already.push({ name: file.name, where: file.where, path: known.path, names: lib.catalog.namesOf(known.sha256), newName })
}

export interface IngestPlan {
  /** Log files found (by extension). */
  logs: number
  /** Already in the library by a checksum the source reported: nothing to read. */
  alreadyKnown: number
  /** Files that must be read (downloaded, for Drive) to be hashed, and their total size: the cost, stated before it is paid. */
  toRead: number
  bytesToRead: number
  ignored: number
}

/** What an ingest of these files would cost, without reading or writing anything. A local file seen unchanged before counts as known. */
export function planIngest(lib: LocalLibrary, files: SourceFile[], seen?: IngestOptions['seen']): IngestPlan {
  const plan: IngestPlan = { logs: 0, alreadyKnown: 0, toRead: 0, bytesToRead: 0, ignored: 0 }
  for (const f of files) {
    if (kindOf(f.name) === null) { plan.ignored++; continue }
    plan.logs++
    const sha = f.sha256 ?? seen?.get(`${f.where}|${f.size}|${f.modifiedTime}`)
    if ((sha && lib.catalog.bySha(sha)) || (f.md5 && lib.catalog.byMd5(f.md5))) plan.alreadyKnown++
    else { plan.toRead++; plan.bytesToRead += f.size }
  }
  return plan
}

/** A local folder, recursive, any structure: every file with its size and modified time. Nothing is opened. */
export async function localFolderFiles(root: string): Promise<SourceFile[]> {
  const { readdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const out: SourceFile[] = []
  const walk = async (dir: string) => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name)
      if (e.isDirectory()) { await walk(path); continue }
      if (!e.isFile() || e.name.startsWith('.')) continue
      const s = await stat(path)
      out.push({ name: e.name, where: path, size: s.size, modifiedTime: Math.round(s.mtimeMs), from: 'folder', open: async () => ({ path, done: async () => {} }) })
    }
  }
  await walk(root)
  return out
}
