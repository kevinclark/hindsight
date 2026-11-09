/**
 * Getting owlet from CTRE's own server when the user presses the button that says downloading it means agreeing to CTRE's
 * licence (src/ui/HootAccess.svelte). The file is checked against CTRE's sha-1 in memory before anything is written, then written under a temporary
 * name and renamed, so a failed download leaves nothing behind. Getting the same version again replaces that file (a
 * damaged copy); nothing else is touched. Main process only.
 */
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { INDEX_URL, owletFileName, pickDownload, platformKey, sha1Of, type FoundOwlet } from './owlet.ts'

export interface DownloadOptions {
  compliancy: number
  platform: string
  arch: string
  /** Hindsight's own owlet folder. */
  dir: string
  fetch?: typeof fetch
  /** Bytes so far of the total (0 when the server gave no length). */
  onBytes?: (done: number, total: number) => void
  log?: (line: string) => void
  signal?: AbortSignal
  /** No byte for this long stops the download, in words. */
  stallMs?: number
}

export async function downloadOwlet(o: DownloadOptions): Promise<FoundOwlet> {
  const get = o.fetch ?? fetch
  let index: unknown
  try {
    const r = await get(INDEX_URL, { redirect: 'error', signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`answered ${r.status}`)
    index = await r.json()
  } catch (e) { throw new Error(`Could not reach CTRE's download list (${INDEX_URL}): ${e instanceof Error ? e.message : String(e)}`) }
  const pick = pickDownload(index, o.compliancy, platformKey(o.platform, o.arch))
  if ('problem' in pick) throw new Error(pick.problem)
  o.log?.(`owlet ${pick.version} (format ${pick.compliancy}) from ${pick.url}`)

  const bytes = await fetchBytes(get, pick.url, o.stallMs ?? 15_000, o.onBytes, o.signal)
  const got = sha1Of(bytes)
  if (got !== pick.sha1) throw new Error(`The owlet CTRE's server sent does not match CTRE's checksum (sha-1 ${got.slice(0, 12)}…, expected ${pick.sha1.slice(0, 12)}…): it was not saved. Try again later.`)

  await mkdir(o.dir, { recursive: true })
  const name = owletFileName(pick.version, pick.compliancy, o.platform)
  const temp = join(o.dir, `.${name}.part-${process.pid}`)
  await writeFile(temp, bytes, { mode: 0o755 })
  await chmod(temp, 0o755)
  await rename(temp, join(o.dir, name))
  o.log?.(`owlet ${pick.version}: ${bytes.length} bytes, sha-1 matches CTRE's, saved as ${name}`)
  return { path: join(o.dir, name), version: pick.version, compliancy: pick.compliancy, where: 'hindsight' }
}

/** The whole body, with progress; stops in words when no byte arrives for `stallMs`. */
async function fetchBytes(get: typeof fetch, url: string, stallMs: number, onBytes?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const abort = new AbortController()
  signal?.addEventListener('abort', () => abort.abort(), { once: true })
  const chunks: Uint8Array[] = []
  let done = 0
  let total = 0
  // Each wait (the answer, then each piece of the body) races a timer: a stalled server can't hold the download open.
  let timer: ReturnType<typeof setTimeout> | undefined
  const STALLED = Symbol('stalled')
  const orStall = <T>(p: Promise<T>): Promise<T | typeof STALLED> => {
    clearTimeout(timer)
    return Promise.race([p, new Promise<typeof STALLED>((resolve) => { timer = setTimeout(() => resolve(STALLED), stallMs) })])
  }
  const stalled = () => new Error(`The download of owlet stopped: nothing arrived for ${Math.round(stallMs / 1000)} s after ${(done / 1e6).toFixed(1)} MB${total ? ` of ${(total / 1e6).toFixed(1)} MB` : ''}.`)
  try {
    // No redirect is followed: the file must come from the CTRE address the index named (CTRE answers it directly, 2026-11-09).
    const r = await orStall(get(url, { redirect: 'error', signal: abort.signal }))
    if (r === STALLED) throw stalled()
    if (!r.ok || !r.body) throw new Error(`CTRE's server answered ${r.status} for ${url}`)
    total = Number(r.headers.get('content-length') ?? 0) || 0
    const reader = r.body.getReader()
    for (;;) {
      if (signal?.aborted) { void reader.cancel().catch(() => {}); throw new Error('The download of owlet was stopped.') }
      const piece = await orStall(reader.read())
      if (piece === STALLED) { void reader.cancel().catch(() => {}); throw stalled() }
      if (piece.done) break
      chunks.push(piece.value)
      done += piece.value.length
      onBytes?.(done, total)
    }
  } catch (e) {
    abort.abort()
    if (signal?.aborted) throw new Error('The download of owlet was stopped.')
    throw e instanceof Error && /^(CTRE's|The download)/.test(e.message) ? e : new Error(`The download of owlet failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally { clearTimeout(timer) }
  const out = new Uint8Array(done)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}
