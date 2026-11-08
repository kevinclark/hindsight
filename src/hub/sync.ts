/**
 * Sharing the library through the team's store. Each machine writes only its own manifest; sync
 *  1. brings teammates' manifests down (they are append-only, so a copy is replaced only by a longer one),
 *  2. puts up the logs this machine brought in that the team store lacks (one at a time, in bands: match logs first
 *     (FMS or on the field), then other dated logs, then logs with no date, each band newest first, so the event going on
 *     now is shared before an old backlog and a batch of boot stubs, each checked on arrival): copied
 *     inside Drive when they came from there, else uploaded; it stops after FAILURES_IN_A_ROW failures in a row, since
 *     those mean something systemic (a rate limit run out, a lost sign-in) and each would cost a minute of back-off,
 *  3. publishes this machine's records for them: the remote manifest is read first, must hold nothing this copy lacks,
 *     and a log's record is written only after its file is there, so a failed upload leaves no record. It publishes as
 *     logs land (at most once per PUBLISH_EVERY_MS, and once at the end), each time appending only the newly eligible lines
 *     after what was last published, so teammates see a long sync's logs while it runs.
 * A manifest or history file whose listed md5 equals the local copy's is not downloaded, and this machine's own manifest is
 * not read back when its md5 is that of what this process last wrote.
 * The triage history (`history/<machine id>.jsonl`) travels the same way, by the same rule, in step 1b: teammates' files
 * down, this machine's up; a copy is replaced only by a longer one that starts with it, anything else is a problem.
 * Nothing is deleted or overwritten on either side.
 */
import { createHash } from 'node:crypto'
import { ManifestConflict, SignInAgain, readText, type FileInfo, type StorageAdapter } from './adapter.ts'
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
  /** History files brought down (teammates', or this machine's own when the team's copy was longer), with how many lines each added; and how many lines of this machine's file went up this sync (0 when nothing new or on a conflict). */
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

/**
 * Upload and download order, in three bands: (a) match logs (`matchType` >= 1 or on the field), newest played first;
 * (b) other dated logs, newest played first; (c) logs with no date, newest added first. Ties keep the order they came in
 * (Array.sort is stable).
 */
export function matchesFirst(a: LogRecord, b: LogRecord): number {
  const band = (r: LogRecord) => ((r.matchType ?? 0) >= 1 || r.onField ? 0 : r.playedAt !== null ? 1 : 2)
  const when = (r: LogRecord) => r.playedAt ?? r.recordedAt
  return band(a) - band(b) || when(b) - when(a)
}

const md5Of = (text: string) => createHash('md5').update(text).digest('hex')

/** Least gap (ms) between manifest publishes during step 3. */
export const PUBLISH_EVERY_MS = 120_000

/**
 * Failed puts in a row after which sync stops trying the remaining logs (the next sync tries them). A run-out rate limit
 * costs ~61 s of back-off per log (drive-adapter.ts), so 5 is up to ~5 min before the stop.
 */
export const FAILURES_IN_A_ROW = 5

export interface SyncOptions {
  onProgress?(done: number, total: number, current: string): void
  cancelled?(): boolean
  /** The clock for the publish interval (ms); tests inject theirs. */
  now?: () => number
  /** Least gap between manifest publishes during uploads. */
  publishEveryMs?: number
  /** Taken around the history step: the same lock the push without a Sync takes (src/hub/live-share.ts), so they never interleave. */
  lock?: { run<T>(work: () => Promise<T>): Promise<T> }
}

export async function syncWithTeam(lib: LocalLibrary, team: StorageAdapter, options: SyncOptions = {}): Promise<SyncReport> {
  const report: SyncReport = { manifests: [], history: [], historyPublished: 0, uploaded: [], failed: [], alreadyThere: 0, published: 0, unrecorded: [], problems: [], remotePaths: [] }
  const own = lib.ownManifestPath

  // 1. Teammates' manifests down.
  for (const f of await team.list('manifests')) {
    if (!f.path.endsWith('.jsonl') || f.path === own) continue
    const mine = (await readText(lib.store, f.path)) ?? ''
    if (f.md5 && f.md5 === md5Of(mine)) continue // unchanged since the last sync: nothing to download
    const text = (await readText(team, f.path)) ?? ''
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
  await (options.lock ? options.lock.run(() => syncHistory(lib, team, report)) : syncHistory(lib, team, report))

  // 2. The remote manifest of this machine must hold nothing this copy lacks (another install with the same machine id).
  const remoteOwn = (await readText(team, own)) ?? '' // the Drive adapter answers from memory when its md5 is unchanged
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
  const todo = mine.filter((r) => !isThere(remote.get(r.path), r)).sort(matchesFirst)
  report.alreadyThere = mine.length - todo.length
  // Publishing: each publish appends the newly eligible lines to what was last published, never a recomputed order
  // (an adapter checks the old content is the start of the new, so a line slipped in between would be a ManifestConflict).
  const publishedLines = [...remoteLines]
  const publishedSet = new Set(remoteLines)
  let stopPublishing = false
  let publishFailed = false // one problem note however many attempts fail
  const publish = async () => {
    if (stopPublishing) return
    const isPublished = new Set(mine.filter((r) => isThere(remote.get(r.path), r)).map((r) => r.sha256))
    const add = localLines.filter((l) => {
      if (publishedSet.has(l)) return false
      const r = parseManifest(l).records[0]
      return r !== undefined && (r.type !== 'log' || isPublished.has(r.sha256))
    })
    if (!add.length) return
    const content = `${[...publishedLines, ...add].join('\n')}\n`
    try { await team.appendManifest(own, content) } catch (e) {
      // Never counted as a failed log: the uploads go on. A lost sign-in ends the job as it does in an upload.
      if (e instanceof SignInAgain) throw e
      if (e instanceof ManifestConflict) {
        stopPublishing = true
        report.problems.push(`${own} changed on the team store while syncing: not published (run sync again)`)
        return
      }
      if (!publishFailed) report.problems.push(`${own}: publishing failed (${e instanceof Error ? e.message : String(e)}); it is tried again, and the next sync publishes what landed`)
      publishFailed = true
      return
    }
    for (const l of add) { publishedLines.push(l); publishedSet.add(l) }
  }
  const now = options.now ?? Date.now
  const every = options.publishEveryMs ?? PUBLISH_EVERY_MS
  let lastPublish = now()

  let done = 0
  let inARow = 0
  for (const r of todo) {
    options.onProgress?.(done, todo.length, r.names[0])
    done++ // not inside the call above: `?.` skips its arguments when there is no onProgress
    if (options.cancelled?.()) break
    const there = remote.get(r.path)
    if (there) { report.failed.push({ path: r.path, reason: `the team store has a different file at this path (${there.size} bytes, or other checksums); left alone and not published` }); continue }
    try {
      const { info, how } = await putLog(lib, team, r)
      report.uploaded.push({ path: r.path, size: info.size, how })
      remote.set(r.path, info)
      inARow = 0
      if (now() - lastPublish >= every) { await publish(); lastPublish = now() } // after an attempt either way: a failure waits the normal gap
    } catch (e) {
      // A lost sign-in ends the job with its own error, so the app asks to sign in; this run's report is given up on
      // purpose: what landed is found by the next sync's listing and published then.
      if (e instanceof SignInAgain) throw e
      const reason = e instanceof Error ? e.message : String(e)
      report.failed.push({ path: r.path, reason })
      if (++inARow === FAILURES_IN_A_ROW) {
        const left = todo.length - done
        report.problems.push(`Stopped after ${inARow} failures in a row (the last: ${reason})${left ? `; ${left} log${left === 1 ? '' : 's'} not tried: run sync again` : ''}`)
        break
      }
    }
  }
  options.onProgress?.(todo.length, todo.length, '')

  // 4. Publish what is left: a log's record only when its file is there; aliases and tags always.
  await publish()
  report.published = publishedLines.length

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
  let ownListed: FileInfo | undefined
  for (const f of await team.list('history')) {
    if (f.path === own) ownListed = f
    if (!f.path.endsWith('.jsonl') || f.path === own) continue
    const mine = (await readText(lib.store, f.path)) ?? ''
    if (f.md5 && f.md5 === md5Of(mine)) continue // unchanged since the last sync
    const text = (await readText(team, f.path)) ?? ''
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
  if (ownListed?.md5 && ownListed.md5 === md5Of(local)) return // the team's copy is this one
  const remote = (await readText(team, own)) ?? ''
  if (local === remote) return
  if (remote.startsWith(local)) {
    // The team has more of this computer's history (a reinstall, a lost library): bring it down; strictly additive.
    await lib.store.appendManifest(own, remote)
    report.history.push({ name: own, lines: linesOf(remote) - linesOf(local) })
    return
  }
  try {
    await team.appendManifest(own, local)
    report.historyPublished = linesOf(local) - linesOf(remote)
  } catch (e) {
    if (!(e instanceof ManifestConflict)) throw e
    report.problems.push(`The team's copy of this computer's history differs from this copy (another install with this id?): not uploaded, nothing overwritten`)
  }
}

/**
 * One log up: copied inside Drive when it came from there, else uploaded from the local copy. A copy that fails is not
 * uploaded instead: the log fails (unpublished, tried again next sync), so a rate limit can't quietly turn into uploading
 * every remaining log. A copy Drive reports without a checksum fails too, and is published by the next sync once Drive
 * lists its checksums. A copy whose size or checksums differ from the library's file fails and stays at its path: later
 * syncs report it as a different file there until it is removed by hand.
 * Returns what the publish step checks with isThere. For a copy, Drive's own answer: the same predicate on the same object
 * as the check below, so changing one means changing the other (no test can tell them apart). For an upload, the
 * record's numbers: writeNew proved the sent bytes against the record's sha-256, and the shape of Drive's
 * upload-completion answer has not been read live (a missing size would read as 0 and un-publish a good upload).
 */
async function putLog(lib: LocalLibrary, team: StorageAdapter, r: LogRecord): Promise<{ info: FileInfo; how: SyncReport['uploaded'][number]['how'] }> {
  if (r.sourceId && team.copyInto) {
    const copy = await team.copyInto(r.sourceId, r.path)
    if (!isThere(copy, r)) throw new Error(`the copy inside Drive is not the library's file (${copy.size} bytes, or other checksums); left there and not published`)
    if (!copy.sha256 && !copy.md5) throw new Error('Drive reported no checksum for the copy; not published until the next sync can check it')
    return { info: copy, how: 'copy inside Drive' }
  }
  const from = await fileSource(lib.store.at(r.path))
  try {
    await team.writeNew(r.path, from, { sha256: r.sha256, ...(r.modifiedTime ? { modifiedTime: r.modifiedTime } : {}) })
    return { info: { path: r.path, size: r.size, modifiedTime: r.modifiedTime, sha256: r.sha256 }, how: 'upload' }
  } finally { await from.close() }
}

export interface FetchReport { fetched: string[]; failed: { path: string; reason: string }[]; /** Anything that stopped the download early. */ problems: string[] }

/**
 * Bring logs the team has and this machine lacks down, match logs first and newest first (so a stopped download has the
 * most useful ones), each under a temp name and renamed only when its sha-256 matches. Stops after FAILURES_IN_A_ROW
 * failures in a row, as uploads do.
 */
export async function fetchLogs(lib: LocalLibrary, team: StorageAdapter, records: LogRecord[], options: SyncOptions = {}): Promise<FetchReport> {
  const report: FetchReport = { fetched: [], failed: [], problems: [] }
  let done = 0
  let inARow = 0
  for (const r of [...records].sort(matchesFirst)) {
    options.onProgress?.(done, records.length, r.names[0])
    done++ // not inside the call above: `?.` skips its arguments when there is no onProgress
    if (options.cancelled?.()) break
    if (await lib.store.stat(r.path)) continue
    try {
      const CHUNK = 8 << 20
      await lib.store.writeNew(r.path, { size: r.size, read: (a, b) => team.read(r.path, a, Math.min(b, a + CHUNK)).then((x) => x) }, { sha256: r.sha256, ...(r.modifiedTime ? { modifiedTime: r.modifiedTime } : {}) })
      report.fetched.push(r.path)
      inARow = 0
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      report.failed.push({ path: r.path, reason })
      if (++inARow === FAILURES_IN_A_ROW) {
        const left = records.length - done
        report.problems.push(`Stopped after ${inARow} failures in a row (the last: ${reason})${left ? `; ${left} log${left === 1 ? '' : 's'} not tried: download again` : ''}`)
        break
      }
    }
  }
  options.onProgress?.(records.length, records.length, '')
  return report
}
