/**
 * Bring logs into the library from anywhere (a folder, a Drive folder, the robot). One file at a time:
 *  - identity is the content (sha-256), so the same bytes under two names are one log with both names remembered, and a
 *    file the library already holds is not read again when the source says its checksum;
 *  - each log is filed by what it says about itself (describe.ts), as a copy: the original is never touched;
 *  - a re-run of the same ingest finds everything already there and writes nothing.
 */
import { stat } from 'node:fs/promises'
import { LinkLost, Stopped, type WriteOptions } from './adapter.ts'
import { fileMeter, type ProgressFn } from './jobs.ts'
import { fileSource, hashFile } from './local-adapter.ts'
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
  /**
   * Names this file's content for the "seen" memory (a local file's path, size and modified time; a Drive file's id and checksum):
   * a file seen unchanged is not read again (a robot file's path, size and modified time too). Absent, the file is read every time.
   */
  cacheKey?: string
  /** The file's id in the store it came from (Drive), if it has one. */
  sourceId?: string
  /** Checksums the source already knows (a Drive listing's); with one of them matching the library the file is not downloaded. */
  sha256?: string
  md5?: string
  /**
   * Make the bytes available as a file on this machine. A local source returns the original path; the original is only read.
   * A source that downloads reports its bytes to `watch.onProgress` and throws Stopped, leaving nothing, when `watch.cancelled` says so.
   */
  open(watch?: Watch): Promise<{ path: string; done(): Promise<void> }>
}

/**
 * Bytes so far, and whether the user asked to stop: what a long copy is told and asks. `onStep` says in words what a
 * transfer is doing that is not moving bytes (reconnecting); `log` adds a line to the job log.
 */
export type Watch = Pick<WriteOptions, 'onProgress' | 'cancelled'> & { onStep?: (words: string) => void; log?: (line: string) => void; /** "33 of 70: name", for the words of a step. */ label?: string }

const UNREADABLE = 'unreadable: '

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
  /** The user pressed Stop; `notTried` files were left for the next time. */
  stopped?: boolean
  notTried?: number
  /** The source's link was lost and stayed lost through every try (the robot): why, in words, with the file it was on. `stopped` is set too. */
  lostLink?: string
  /** Set by the app when code linking ran after the add (src/hub/ingest-link.ts): logs linked, GitHub API requests made, and whether the cap stopped it. */
  linked?: number
  linkRequests?: number
  linkCapped?: boolean
  /** When GitHub's own request limit stopped the linking: when it resets (ms since 1970). Not the same as the cap. */
  linkRateLimitedUntil?: number
  /** Why linking could not finish, in words; the logs were added all the same. */
  linkProblem?: string
}

export interface IngestOptions {
  describe(path: string, name: string): Promise<Described>
  now?: () => number
  /** Files done of files to do, the file now; with bytes over the job and the file. */
  onProgress?: ProgressFn
  /** Files already read, by their `cacheKey`: a sha-256, or `unreadable: <why>` for a file that would not read. A hit skips reading the file. */
  seen?: { get(key: string): string | undefined; set(key: string, sha256: string): void }
  /** Stop early (the user pressed cancel). */
  cancelled?: () => boolean
  /** Awaited after each file, whatever became of it (also when the ingest stops there): the app saves its seen memory here, so a stall, Stop or crash at file 33 keeps files 1-32. */
  afterEach?: () => Promise<void>
  /** Lines for the job log: each file's start and end, and what a transfer reports. */
  log?: (line: string) => void
}

export async function ingest(lib: LocalLibrary, files: SourceFile[], options: IngestOptions): Promise<IngestReport> {
  const now = options.now ?? Date.now
  const started = now()
  const report: IngestReport = { added: [], already: [], unreadable: [], ignored: 0, bytesAdded: 0, durationMs: 0 }
  const logs = files.filter((f) => kindOf(f.name) !== null)
  const meter = fileMeter(options.onProgress, logs.map((f) => f.size))
  report.ignored = files.length - logs.length
  const log = options.log
  for (const [index, file] of logs.entries()) {
    const { at, step, end } = meter.start(index, logs.length, file.name, file.size, file.from !== 'folder')
    if (options.cancelled?.()) { report.stopped = true; break }
    const began = now()
    let sent = 0
    log?.(`file ${index + 1} of ${logs.length} start: ${file.name}, ${file.size} bytes`)
    const finished = (outcome: string) => {
      const secs = Math.max(0.001, (now() - began) / 1000)
      log?.(`file ${index + 1} of ${logs.length} end: ${file.name}: ${outcome}, ${sent} bytes, ${secs.toFixed(1)} s, ${(sent / secs / 2 ** 20).toFixed(2)} MB/s average`)
    }
    const added = report.added.length
    try {
      await ingestOne(lib, file, options, report, now, { onProgress: (s) => { sent = s; at(s) }, cancelled: options.cancelled, onStep: step, log, label: `${index + 1} of ${logs.length}: ${file.name}` })
      finished(report.added.length > added ? 'added' : 'already in the library')
    } catch (e) {
      // Stop part way through a file: what was copied of it is gone, and it is not unreadable.
      if (e instanceof Stopped) { finished('stopped'); report.stopped = true; break }
      // The link is gone: end the pull here (another file would meet the same wait), and say why. Not unreadable, nothing remembered.
      if (e instanceof LinkLost) {
        finished(`link lost: ${e.reason}`)
        report.stopped = true
        report.lostLink = `Stopped at file ${index + 1} of ${logs.length} (${file.name}): ${e.reason}. ${report.added.length + report.already.length} of the robot's ${logs.length} logs are in the library (${report.added.length} added this pull). Pull again to continue from here.`
        break
      }
      const reason = e instanceof Error ? e.message : String(e)
      finished(`unreadable: ${reason}`)
      report.unreadable.push({ name: file.name, where: file.where, reason })
    } finally {
      end()
      await options.afterEach?.()
    }
  }
  if (report.stopped) report.notTried = logs.length - report.added.length - report.already.length - report.unreadable.length
  report.durationMs = now() - started
  return report
}

async function ingestOne(lib: LocalLibrary, file: SourceFile, options: IngestOptions, report: IngestReport, now: () => number, watch: Watch): Promise<void> {
  const remembered = file.cacheKey ? options.seen?.get(file.cacheKey) : undefined
  // A file that would not read last time, unchanged, is reported again without being read (a Drive file would be downloaded again).
  if (remembered?.startsWith(UNREADABLE)) throw new Error(remembered.slice(UNREADABLE.length))
  // 1. Known without reading it: the source's own checksum, or a file seen unchanged before.
  const knownSha = file.sha256 ?? remembered
  const known = (knownSha ? lib.catalog.bySha(knownSha) : undefined) ?? (file.md5 ? lib.catalog.byMd5(file.md5) : undefined)
  if (known) return noteAlready(lib, file, known, report, now)

  // The bar follows the slow part: the download when the source has one, else the copy into the library.
  let downloaded = false
  const source = await file.open({ cancelled: watch.cancelled, onStep: watch.onStep, log: watch.log, onProgress: (sent, total) => { downloaded = true; watch.onProgress?.(sent, total) } })
  // What the bar says once the bytes are in (the file bar stays full): hashing a big log takes a while, and so does filing it.
  if (downloaded) watch.onStep?.(`Reading ${watch.label ?? file.name}`)
  try {
    // 2. Read it: hash and what it says about itself. A file that will not read is reported, not filed.
    let d: Described
    try { d = await options.describe(source.path, file.name) } catch (e) {
      if (file.cacheKey) options.seen?.set(file.cacheKey, `${UNREADABLE}${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
    // Remembered only once the library holds this content (found here, or filed below): a Stop during the copy leaves nothing remembered.
    const remember = () => { if (file.cacheKey) options.seen?.set(file.cacheKey, d.sha256) }
    const again = lib.catalog.bySha(d.sha256)
    if (again) { remember(); return noteAlready(lib, file, again, report, now) }
    // A hoot file with no time in its name, pulled from the robot: the roboRIO's modified time, recorded at the pull, is its date.
    if (d.meta.kind === 'hoot' && d.meta.playedAt === null && file.from === 'robot' && file.modifiedTime) d.meta = { ...d.meta, playedAt: file.modifiedTime, dateSource: 'file time' }

    // 3. File a copy.
    const path = await freePath(lib, libraryPath(d.meta, file.name), d.sha256)
    if (!(await lib.store.stat(path))) {
      if (downloaded) watch.onStep?.(`Filing ${watch.label ?? file.name}`)
      const from = await fileSource(source.path)
      try { await lib.store.writeNew(path, from, { sha256: d.sha256, cancelled: watch.cancelled, ...(downloaded ? {} : { onProgress: watch.onProgress }) }) } finally { await from.close() }
    }
    const record: LogRecord = {
      type: 'log', ...d.meta, sha256: d.sha256, md5: d.md5, size: d.size, path, names: [file.name],
      modifiedTime: file.modifiedTime, from: file.from, ...(file.sourceId ? { sourceId: file.sourceId } : {}), recordedAt: now(), machine: lib.machine,
    }
    await lib.append(record)
    remember()
    report.added.push({ name: file.name, where: file.where, path, size: d.size, undated: d.meta.playedAt === null, stub: d.meta.stub })
    report.bytesAdded += d.size
  } finally {
    await source.done()
  }
}

/** The path to file under: the layout path if free; else with the content's first 8 digits added. A copy of this very content already there (a crash before its record was written) is reused. */
async function freePath(lib: LocalLibrary, path: string, sha256: string): Promise<string> {
  for (const candidate of [path, withShaSuffix(path, sha256)]) {
    // Taken by another log this library knows (a teammate's, not downloaded here): its file is not on this disk, but the path is theirs.
    const recorded = lib.catalog.byPath(candidate)
    if (recorded && recorded.sha256 !== sha256) continue
    if (!(await lib.store.stat(candidate))) return candidate
    if ((await hashFile(lib.store.at(candidate))).sha256 === sha256) return candidate
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
    const sha = f.sha256 ?? (f.cacheKey ? seen?.get(f.cacheKey) : undefined)
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
      if (e.name.startsWith('.')) continue
      // A symlink to a file counts as the file (a symlink to a folder is not followed: it could loop).
      const s = e.isFile() || e.isSymbolicLink() ? await stat(path).catch(() => null) : null
      if (!s?.isFile()) continue
      out.push({ name: e.name, where: path, size: s.size, modifiedTime: Math.round(s.mtimeMs), from: 'folder', cacheKey: `${path}|${s.size}|${Math.round(s.mtimeMs)}`, open: async () => ({ path, done: async () => {} }) })
    }
  }
  await walk(root)
  return out
}
