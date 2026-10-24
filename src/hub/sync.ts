/**
 * Sharing the library through the team's store. Each machine writes only its own manifest; sync
 *  1. brings teammates' manifests down (they are append-only, so a copy is replaced only by a longer one),
 *  2. puts up the logs this machine brought in that the team store lacks (one at a time, each checked on arrival): copied
 *     inside Drive when they came from there, else uploaded,
 *  3. publishes this machine's records for them: the remote manifest is read first, must hold nothing this copy lacks,
 *     and a log's record is written only after its file is there, so a failed upload leaves no record.
 * The triage history (`history/<machine id>.jsonl`) travels the same way, by the same rule, in step 1b: teammates' files
 * down, this machine's up; a copy is replaced only by a longer one that starts with it, anything else is a problem.
 * Nothing is deleted or overwritten on either side.
 */
import { ManifestConflict, readText, type FileInfo, type StorageAdapter } from './adapter.ts'
import type { LocalLibrary } from './library-store.ts'
import { fileSource } from './local-adapter.ts'
import type { LogRecord } from './types.ts'
import { parseManifest } from './types.ts'

export interface SyncReport {
  /** Teammates' manifests brought down, with how many records each added. */
  manifests: { name: string; records: number }[]
  uploaded: { path: string; size: number; how: 'upload' | 'copy inside Drive' }[]
  failed: { path: string; reason: string }[]
  /** Logs the team store already had. */
  alreadyThere: number
  /** Own records now in the team's manifest. */
  published: number
  /** Files in the team's logs/ that no manifest mentions (a manifest write that failed, or files put there by hand). */
  unrecorded: string[]
  /** Teammates' history files brought down, with how many lines each added; and whether this machine's file went up. */
  history: { name: string; lines: number }[]
  historyPublished: number
  /** Anything that stopped part of the sync (a manifest that changed under us). */
  problems: string[]
  /** Paths in the team's logs/ after the sync: what "shared" means in the Library view. */
  remotePaths: string[]
}

/** The store holds this log: same size, and every checksum it reports agrees (a corrupted upload keeps its size). */
function isThere(remote: FileInfo | undefined, r: LogRecord): boolean {
  if (!remote || remote.size !== r.size) return false
  if (remote.sha256 && remote.sha256 !== r.sha256) return false
  if (remote.md5 && r.md5 && remote.md5 !== r.md5) return false
  return true
}

export interface SyncOptions {
  onProgress?(done: number, total: number, current: string): void
  cancelled?(): boolean
}

export async function syncWithTeam(lib: LocalLibrary, team: StorageAdapter, options: SyncOptions = {}): Promise<SyncReport> {
  const report: SyncReport = { manifests: [], history: [], historyPublished: 0, uploaded: [], failed: [], alreadyThere: 0, published: 0, unrecorded: [], problems: [], remotePaths: [] }
  const own = lib.ownManifestPath

  // 1. Teammates' manifests down.
  for (const f of await team.list('manifests')) {
    if (!f.path.endsWith('.jsonl') || f.path === own) continue
    const text = (await readText(team, f.path)) ?? ''
    const mine = (await readText(lib.store, f.path)) ?? ''
    if (text === mine) continue
    try {
      await lib.store.appendManifest(f.path, text)
      report.manifests.push({ name: f.path, records: parseManifest(text).records.length - parseManifest(mine).records.length })
    } catch (e) {
      if (e instanceof ManifestConflict) report.problems.push(`${f.path} was rewritten, not appended to: kept the copy already here`)
      else throw e
    }
  }
  await lib.reload()

  // 1b. The triage history, both ways. It does not depend on the logs, so a problem with a manifest never holds it back.
  await syncHistory(lib, team, report)

  // 2. The remote manifest of this machine must hold nothing this copy lacks (another install with the same machine id).
  const remoteOwn = (await readText(team, own)) ?? ''
  const localLines = lib.ownLines()
  const localSet = new Set(localLines)
  const remoteLines = remoteOwn.split('\n').filter((l) => l !== '')
  if (remoteLines.some((l) => !localSet.has(l))) {
    report.problems.push(`The team's copy of this computer's manifest holds records this copy lacks (another install with this id?). Nothing was uploaded or published.`)
    report.remotePaths = (await team.list('logs')).map((f) => f.path)
    return report
  }

  // 3. Uploads: this machine's logs the team store lacks.
  const remote = new Map((await team.list('logs')).map((f) => [f.path, f]))
  const mine = lib.catalog.all().filter((r) => r.machine === lib.machine)
  const todo = mine.filter((r) => !isThere(remote.get(r.path), r))
  report.alreadyThere = mine.length - todo.length
  let done = 0
  for (const r of todo) {
    options.onProgress?.(done++, todo.length, r.names[0])
    if (options.cancelled?.()) break
    const there = remote.get(r.path)
    if (there) { report.failed.push({ path: r.path, reason: `the team store has a different file at this path (${there.size} bytes, or other checksums); left alone and not published` }); continue }
    try {
      report.uploaded.push(await putLog(lib, team, r))
      remote.set(r.path, { path: r.path, size: r.size, modifiedTime: r.modifiedTime, sha256: r.sha256 })
    } catch (e) {
      report.failed.push({ path: r.path, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  options.onProgress?.(todo.length, todo.length, '')

  // 4. Publish: a log's record only when its file is there; aliases and tags always.
  const published = new Set(mine.filter((r) => isThere(remote.get(r.path), r)).map((r) => r.sha256))
  const lineOk = (line: string) => {
    const r = parseManifest(line).records[0]
    return r !== undefined && (r.type !== 'log' || published.has(r.sha256))
  }
  let conflicted = false
  const remoteSet = new Set(remoteLines)
  const add = localLines.filter((l) => !remoteSet.has(l) && lineOk(l))
  if (add.length) {
    const content = `${[...remoteLines, ...add].join('\n')}\n`
    try { await team.appendManifest(own, content) } catch (e) {
      if (!(e instanceof ManifestConflict)) throw e
      conflicted = true
      report.problems.push(`${own} changed on the team store while syncing: not published (run sync again)`)
    }
  }
  report.published = remoteLines.length + (conflicted ? 0 : add.length)

  await lib.reload()
  const known = new Set(lib.catalog.all().map((r) => r.path))
  report.remotePaths = [...remote.keys()]
  report.unrecorded = report.remotePaths.filter((p) => !known.has(p))
  return report
}

const linesOf = (text: string) => text.split('\n').filter((l) => l.trim() !== '').length

/** Teammates' history files down and this machine's up, each only when the older copy is the start of the newer one. */
async function syncHistory(lib: LocalLibrary, team: StorageAdapter, report: SyncReport): Promise<void> {
  const own = lib.ownHistoryPath
  for (const f of await team.list('history')) {
    if (!f.path.endsWith('.jsonl') || f.path === own) continue
    const text = (await readText(team, f.path)) ?? ''
    const mine = (await readText(lib.store, f.path)) ?? ''
    if (text === mine) continue
    try {
      await lib.store.appendManifest(f.path, text)
      report.history.push({ name: f.path, lines: linesOf(text) - linesOf(mine) })
    } catch (e) {
      if (e instanceof ManifestConflict) report.problems.push(`${f.path} on the team store is shorter than, or differs from, the copy already here: kept the copy already here`)
      else throw e
    }
  }
  const local = (await readText(lib.store, own)) ?? ''
  const remote = (await readText(team, own)) ?? ''
  if (local === remote) { report.historyPublished = linesOf(local); return }
  try {
    await team.appendManifest(own, local)
    report.historyPublished = linesOf(local)
  } catch (e) {
    if (!(e instanceof ManifestConflict)) throw e
    report.historyPublished = linesOf(remote)
    report.problems.push(`The team's copy of this computer's history holds lines this copy lacks (another install with this id?): not uploaded, nothing overwritten`)
  }
}

/**
 * One log up: copied inside Drive when it came from there, else uploaded from the local copy. A copy that fails is not
 * uploaded instead: the log fails (unpublished, tried again next sync), so a rate limit can't quietly turn into uploading
 * every remaining log. A copy Drive reports without a checksum fails too, and is published by the next sync once Drive
 * lists its checksums. A copy whose size or checksums differ from the library's file fails and stays at its path: later
 * syncs report it as a different file there until it is removed by hand.
 */
async function putLog(lib: LocalLibrary, team: StorageAdapter, r: LogRecord): Promise<SyncReport['uploaded'][number]> {
  if (r.sourceId && team.copyInto) {
    const copy = await team.copyInto(r.sourceId, r.path)
    if (!isThere(copy, r)) throw new Error(`the copy inside Drive is not the library's file (${copy.size} bytes, or other checksums); left there and not published`)
    if (!copy.sha256 && !copy.md5) throw new Error('Drive reported no checksum for the copy; not published until the next sync can check it')
    return { path: r.path, size: copy.size, how: 'copy inside Drive' }
  }
  const from = await fileSource(lib.store.at(r.path))
  try {
    const info = await team.writeNew(r.path, from, { sha256: r.sha256, ...(r.modifiedTime ? { modifiedTime: r.modifiedTime } : {}) })
    return { path: r.path, size: info.size, how: 'upload' }
  } finally { await from.close() }
}

export interface FetchReport { fetched: string[]; failed: { path: string; reason: string }[] }

/** Bring logs the team has and this machine lacks down, each under a temp name and renamed only when its sha-256 matches. */
export async function fetchLogs(lib: LocalLibrary, team: StorageAdapter, records: LogRecord[], options: SyncOptions = {}): Promise<FetchReport> {
  const report: FetchReport = { fetched: [], failed: [] }
  let done = 0
  for (const r of records) {
    options.onProgress?.(done++, records.length, r.names[0])
    if (options.cancelled?.()) break
    if (await lib.store.stat(r.path)) continue
    try {
      const CHUNK = 8 << 20
      await lib.store.writeNew(r.path, { size: r.size, read: (a, b) => team.read(r.path, a, Math.min(b, a + CHUNK)).then((x) => x) }, { sha256: r.sha256, ...(r.modifiedTime ? { modifiedTime: r.modifiedTime } : {}) })
      report.fetched.push(r.path)
    } catch (e) { report.failed.push({ path: r.path, reason: e instanceof Error ? e.message : String(e) }) }
  }
  options.onProgress?.(records.length, records.length, '')
  return report
}
