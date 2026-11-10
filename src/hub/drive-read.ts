/**
 * The read half of the Drive client: list, stat and ranged read over fetch, with the retries, back-off and token refresh
 * every Drive call needs. The phone uses it alone (scope drive.readonly, nothing written); DriveAdapter extends it with
 * the writes. It sends GET and nothing else, and no `node:` module is imported here, so a phone build can bundle it.
 *
 * Never silent (transfer-watch.ts): every request, its answer and its body are watched, so nothing moving for the stall
 * time aborts it, and Stop aborts it at once. A stalled or dropped ranged read asks again for the rest from the next byte
 * (never from the start); after TRIES stalls (or RETRIES dropped connections) with no byte moving, LinkLost says why.
 */
import { LinkLost, SignInAgain, Stopped, checkPath, stopIfAsked, type FileInfo, type TransferWatch } from './adapter.ts'
import { STALL_MS, Stalled, TRIES, atWords, backoff, secsWords, tripwire, within, type Watchdog } from './transfer-watch.ts'
import { readAhead } from './read-ahead.ts'

export const API = 'https://www.googleapis.com/drive/v3'
export const FOLDER = 'application/vnd.google-apps.folder'
export const FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum'
export const RETRIES = 5
/** A per-user rate limit asks for a longer wait: up to a minute in all, backing off 1, 2, 4, 8, 16, 30 s (Google's own advice). */
const RATE_RETRIES = 7

export interface DriveOptions {
  /** The folder everything lives under (the team folder's id). */
  rootId: string
  /** A current access token. `refresh` true asks for a new one (the last was refused). Throws SignInAgain when it can't. */
  token(refresh?: boolean): Promise<string>
  fetch?: typeof fetch
  sleep?(ms: number): Promise<void>
  /** Nothing moving for this long is a stall (default STALL_MS; tests make it short). */
  stallMs?: number
}

/** A request's watch, and what only the adapter's own calls ask for. */
export interface RequestWatch extends TransferWatch {
  /** A ranged read of bytes `[start, end)` of a file of `size`: a stall or dropped connection mid-body asks for the rest from the next byte. */
  range?: { start: number; end: number; size: number }
  /** An upload body, handed to the connection in pieces as it takes them, so a stalled upload shows (fetch can't count bytes sent). */
  upload?: Uint8Array
  /** No retry here after a stall, a dropped connection or a 5xx: the caller asks Drive what it kept (an upload chunk). */
  once?: boolean
}

/** A whole-file download (the phone) is read in slices of this size, the size the Drive sync moves a log in. */
export const PIECE_READ = 8 << 20
/** Pieces an upload body is handed over in: each one taken is data moving. */
const PIECE = 256 << 10
const NULL_BODY = new Set([101, 103, 204, 205, 304])
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Failures since bytes last moved, by kind: a stall is tried TRIES times in all, a dropped connection or a 5xx RETRIES. */
export class Tries {
  private stalls = 0
  private others = 0
  moved(): void { this.stalls = 0; this.others = 0 }
  /** Counts a failure; `{ n, of }` is this try's number and the limit for its kind. */
  count(stalled: boolean): { n: number; of: number } { return stalled ? { n: ++this.stalls, of: TRIES } : { n: ++this.others, of: RETRIES } }
}

/**
 * One fetch with its answer read whole, under a watchdog: nothing moving for the stall time throws Stalled, Stop throws
 * Stopped. The fetch is aborted and every wait is also raced against the watchdog, so a fetch that ignored the abort
 * could not hold it either.
 */
async function send(doFetch: typeof fetch, url: string, init: RequestInit, more: RequestWatch, stallMs: number, got: { status: number; headers: Headers; parts: Uint8Array[]; n: number }): Promise<void> {
  const ctl = new AbortController()
  const t = tripwire({ stallMs, cancelled: more.cancelled, abort: (why) => ctl.abort(why) })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const upload = more.upload?.length ? { body: pieces(more.upload, t, more.onBytes), duplex: 'half' } : {}
    const res = await Promise.race([doFetch(url, { ...init, ...upload, signal: ctl.signal } as RequestInit), t.fired])
    got.status = res.status
    got.headers = res.headers
    t.alive()
    reader = res.body?.getReader()
    for (let r = await (reader && Promise.race([reader.read(), t.fired])); r && !r.done; r = await Promise.race([reader!.read(), t.fired])) {
      t.alive()
      got.parts.push(r.value)
      got.n += r.value.length
      if (!more.upload) more.onBytes?.(got.n)
    }
    reader = undefined
  } finally {
    t.done()
    reader?.cancel().catch(() => {})
  }
}

/**
 * An upload body as a stream the connection pulls from: each piece taken is data moving. The last piece taken leaves
 * what is still in the connection's buffers to drain unseen, so Drive's answer is allowed as long again as the hand-over
 * took (measured: the buffers held ~1.5 MB of a 4 MiB body, under half, so the drain takes no longer than the hand-over).
 */
function pieces(bytes: Uint8Array, dog: Watchdog, onBytes?: (n: number) => void): ReadableStream<Uint8Array> {
  let at = 0
  const began = Date.now()
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (at >= bytes.length) return c.close()
      const piece = bytes.slice(at, at + PIECE)
      at += piece.length
      dog.alive(at >= bytes.length ? Date.now() - began : 0)
      onBytes?.(at)
      c.enqueue(piece)
    },
  }, { highWaterMark: 0 })
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

export interface DriveFile { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; md5Checksum?: string; sha256Checksum?: string }

export class DriveError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

/** The only requests a reader may send: a GET of the file list, one file's metadata or content, or the shared drives. */
export function isReadOnlyRequest(method: string, url: string): boolean {
  if (method !== 'GET') return false
  const u = url.split('?')[0]
  const files = `${API}/files`
  return u === files || u === `${API}/drives` || (u.startsWith(`${files}/`) && !u.slice(files.length + 1).includes('/'))
}

export class DriveReader {
  protected readonly opts: DriveOptions
  protected readonly fetch: typeof fetch
  protected readonly sleep: (ms: number) => Promise<void>
  protected readonly stallMs: number
  /** path → folder id. */
  protected folders = new Map<string, string>()
  /** Logs are never rewritten, so a log's file is remembered by path (a manifest changes, so it is looked up each time). */
  protected logs = new Map<string, DriveFile>()
  /** Counts of calls by kind, for the dry run's cost and the tests. */
  readonly calls = { list: 0, upload: 0, download: 0, copy: 0 }

  constructor(opts: DriveOptions) {
    this.opts = opts
    this.fetch = opts.fetch ?? globalThis.fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.stallMs = opts.stallMs ?? STALL_MS
    this.folders.set('', opts.rootId)
  }

  async list(prefix: string): Promise<FileInfo[]> {
    const start = checkPath(prefix)
    const single = await this.stat(start)
    if (single) return [single]
    const folder = await this.folderId(start, false)
    if (!folder) return []
    const out: FileInfo[] = []
    const walk = async (id: string, path: string) => {
      for (const f of await this.children(id)) {
        const p = `${path}/${f.name}`
        if (f.mimeType === FOLDER) { this.folders.set(p, f.id); await walk(f.id, p) } else out.push(infoOf(p, f))
      }
    }
    await walk(folder, start)
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async stat(path: string): Promise<FileInfo | null> {
    const f = await this.find(path)
    return f ? infoOf(path, f) : null
  }

  /** Bytes `[start, end)` of a file, by a Range GET. */
  async read(path: string, start: number, end: number, watch: TransferWatch = {}): Promise<Uint8Array> {
    const f = await this.find(path)
    if (!f) throw new Error(`${path} not found`)
    return this.fetchRange(f, start, end, watch)
  }

  /**
   * A whole file (the phone opening a log), into one buffer of its size, in slices of PIECE_READ bytes, each by the same
   * watched, resumable ranged read as `read`: a stall or a dropped connection asks for the rest of that slice from the next
   * byte; `signal` stops it (Stopped); progress counts the bytes in. The next slice is asked for once the one before starts
   * arriving (readAhead), so the bar doesn't pause between slices. Slices keep the peak near one copy of the file plus a
   * slice or two (one ranged read of the whole file is buffered several times over on its way through `request`).
   */
  async downloadWhole(path: string, opts: { onProgress?(got: number, total: number): void; signal?: AbortSignal; log?(line: string): void } = {}): Promise<Uint8Array> {
    opts.signal?.throwIfAborted()
    const f = await this.find(path)
    if (!f) throw new Error(`${path} not found`)
    const total = Number(f.size ?? 0)
    const out = new Uint8Array(total)
    const cancelled = () => opts.signal?.aborted ?? false
    const slices = readAhead(total, (a, b, watch) => this.fetchRange(f, a, b, watch), { cancelled, onBytes: (n) => opts.onProgress?.(n, total), log: opts.log, onStep: opts.log })
    try {
      for (let at = 0; at < total; at += PIECE_READ) {
        const end = Math.min(at + PIECE_READ, total)
        const part = await slices.read(at, end)
        opts.log?.(`bytes ${at}-${end - 1}: got ${part.length}`)
        if (part.length !== end - at) throw new Error(`${path}: got ${at + part.length} of ${total} bytes`)
        out.set(part, at)
      }
    } finally { slices.close() }
    return out
  }

  /** Name and kind of a folder by id (to show what was chosen); null if it can't be seen. */
  async describeFolder(id: string): Promise<{ id: string; name: string } | null> {
    try {
      const res = await this.request(`${API}/files/${id}?fields=id,name,mimeType&supportsAllDrives=true`)
      const f = (await res.json()) as DriveFile
      return f.mimeType === FOLDER ? { id: f.id, name: f.name } : null
    } catch (e) { if (e instanceof DriveError && (e.status === 404 || e.status === 403)) return null; throw e }
  }

  /** The folders directly under a folder (or, for 'root', My Drive's top and the shared drives), for the folder picker. */
  async folderChoices(parentId: string): Promise<{ id: string; name: string }[]> {
    if (parentId === 'roots') {
      const drives: { id: string; name: string }[] = [{ id: 'root', name: 'My Drive' }]
      for (let page: string | undefined; ; ) {
        const res = await this.request(`${API}/drives?pageSize=100${page ? `&pageToken=${page}` : ''}`)
        const body = (await res.json()) as { drives?: { id: string; name: string }[]; nextPageToken?: string }
        drives.push(...(body.drives ?? []))
        page = body.nextPageToken
        if (!page) return drives
      }
    }
    return (await this.children(parentId)).filter((f) => f.mimeType === FOLDER).map((f) => ({ id: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name))
  }

  protected async fetchRange(f: DriveFile, start: number, end: number, watch: TransferWatch = {}): Promise<Uint8Array> {
    this.calls.download++
    const res = await this.request(`${API}/files/${f.id}?alt=media&supportsAllDrives=true`, {}, [], { ...watch, range: { start, end, size: Number(f.size ?? 0) } })
    return new Uint8Array(await res.arrayBuffer())
  }

  protected async children(folderId: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    for (let page: string | undefined; ; ) {
      this.calls.list++
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives', ...(page ? { pageToken: page } : {}),
      })
      const body = (await (await this.request(`${API}/files?${params}`)).json()) as { files?: DriveFile[]; nextPageToken?: string }
      out.push(...(body.files ?? []))
      page = body.nextPageToken
      if (!page) return out
    }
  }

  protected async find(path: string): Promise<DriveFile | null> {
    const cached = this.logs.get(path)
    if (cached) return cached
    const { parent, name } = splitPath(checkPath(path))
    const folder = await this.folderId(parent, false)
    if (!folder) return null
    const params = new URLSearchParams({
      q: `'${folder}' in parents and name = '${escapeQ(name)}' and trashed = false`, fields: `files(${FIELDS})`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives',
    })
    this.calls.list++
    const body = (await (await this.request(`${API}/files?${params}`)).json()) as { files?: DriveFile[] }
    const found = body.files?.find((f) => f.mimeType !== FOLDER) ?? null
    if (found && path.startsWith('logs/')) this.logs.set(path, found)
    return found
  }

  /** The id of the folder at `path` under the root; created (each part, once) when `create`, else null if missing. A reader never creates. */
  protected async folderId(path: string, create: boolean): Promise<string | null> {
    const known = this.folders.get(path)
    if (known) return known
    const { parent, name } = splitPath(path)
    const above = await this.folderId(parent, create)
    if (!above) return null
    this.calls.list++
    const params = new URLSearchParams({
      q: `'${above}' in parents and name = '${escapeQ(name)}' and mimeType = '${FOLDER}' and trashed = false`, fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives',
    })
    const found = ((await (await this.request(`${API}/files?${params}`)).json()) as { files?: { id: string }[] }).files?.[0]?.id
    let id = found ?? null
    if (!id && create) id = await this.createFolder(above, name)
    if (id) this.folders.set(path, id)
    return id
  }

  /** A reader has no way to make a folder; DriveAdapter overrides this. */
  protected async createFolder(_parentId: string, _name: string): Promise<string> {
    throw new Error('a read-only Drive client cannot create a folder')
  }

  /** Whether this client may send the request. The reader's answer is GET only; DriveAdapter widens it. */
  protected allows(method: string, url: string): boolean {
    return isReadOnlyRequest(method, url)
  }

  /**
   * One authorised request with retries; throws DriveError for a refusal, SignInAgain when the token can't be renewed,
   * Stopped on Stop, and LinkLost when stalls or dropped connections used up their tries with no byte moving.
   */
  protected async request(url: string, init: RequestInit = {}, okStatuses: number[] = [], more: RequestWatch = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    if (!this.allows(method, url)) throw new Error(`Hindsight never sends ${method} ${url.split('?')[0]} to Drive`)
    // Creating a folder or a copy is not repeated after a lost answer (the first may have worked): the caller looks first next time.
    const retryNetwork = !more.once && (method !== 'POST' || url.includes('uploadType=resumable'))
    const range = more.range
    // A ranged read ends at its end or the file's, whichever is first; its bytes so far are kept across tries, and a retry asks only for the rest.
    const last = range ? (range.size > 0 ? Math.min(range.end, range.size) : range.end) : 0
    const kept: Uint8Array[] = []
    let have = 0
    const whole = () => new Response(concat(kept) as unknown as BodyInit, { status: 206 })
    const at = () => (range ? `, ${atWords(range.start + have, range.size)}` : '')
    const tries = new Tries()
    let rateLimited = 0
    let serverErrors = 0
    let refreshed = false
    /** After a stall or a lost connection: count it, say so, and wait; or, out of tries, LinkLost in words. */
    const again = async (e: unknown, words: string, stalled: boolean) => {
      if (!retryNetwork) throw stalled ? new Stalled(words) : e
      const { n, of } = tries.count(stalled)
      more.log?.(`${stalled ? 'stall' : 'link lost'} (try ${n} of ${of}): ${words}`)
      if (n >= of) throw new LinkLost(`${words}; tried ${n} time${n === 1 ? '' : 's'}`, e)
      more.onStep?.(`${stalled ? 'Google Drive stopped sending' : 'Lost the connection to Google Drive'}; trying again (try ${n + 1} of ${of})`)
      await this.wait(backoff(n), more.cancelled)
    }
    for (;;) {
      stopIfAsked(more.cancelled)
      if (range && range.start + have >= last) return whole()
      let token: string
      try { token = await within(this.opts.token(refreshed), this.stallMs, more.cancelled) } catch (e) {
        if (!(e instanceof Stalled)) throw e
        await again(e, `no answer from Google sign-in for ${secsWords(this.stallMs)}`, true)
        continue
      }
      const headers = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}`, ...(range ? { Range: `bytes=${range.start + have}-${last - 1}` } : {}) }
      const got = { status: 0, headers: new Headers(), parts: [] as Uint8Array[], n: 0 }
      // A ranged answer counts only when it is the rest asked for: a 206 from the next byte (or a 200 of the whole file from byte 0).
      const fits = () => {
        if (got.status === 200) return range!.start + have === 0
        if (got.status !== 206) return false
        const from = /^bytes (\d+)-/.exec(got.headers.get('content-range') ?? '')
        return !from || Number(from[1]) === range!.start + have
      }
      const keep = () => { if (!fits()) return false; kept.push(...got.parts); have += got.n; if (got.n > 0) tries.moved(); return true }
      const onBytes = more.onBytes
      try {
        await send(this.fetch, url, { ...init, headers }, { ...more, onBytes: range ? (n) => { if (fits()) onBytes?.(Math.min(have + n, last - range.start)) } : onBytes }, this.stallMs, got)
      } catch (e) {
        if (e instanceof Stopped) throw e
        if (range) keep()
        const stalled = e instanceof Stalled
        await again(e, stalled ? `${got.status ? 'no data' : 'no answer'} from Google Drive for ${secsWords(this.stallMs)}${at()}` : `lost the connection to Google Drive (${msg(e)})${at()}`, stalled)
        continue
      }
      const res = new Response((got.n || !NULL_BODY.has(got.status) ? concat(got.parts) : null) as unknown as BodyInit, { status: got.status, headers: got.headers })
      if (res.ok || okStatuses.includes(res.status)) {
        if (!range) return res
        if (!keep()) throw new DriveError(got.status, `Google Drive answered ${got.status} ${got.headers.get('content-range') ?? ''} to a request for bytes ${range.start + have}-${last - 1}`)
        // An answer that ended cleanly but short is a dropped connection: ask for the rest.
        if (range.start + have < last) { await again(new Error('ended early'), `Google Drive ended its answer early${at()}`, false); continue }
        return new Response(concat(kept).subarray(0, last - range.start) as unknown as BodyInit, { status: 206 })
      }
      if (res.status === 401 && !refreshed) { refreshed = true; continue }
      const limited = res.status === 429 || (res.status === 403 && (await isRateLimit(res)))
      if (limited && rateLimited < RATE_RETRIES - 1) { await this.wait(Math.min(2 ** rateLimited++, 30) * 1000 + Math.random() * 250, more.cancelled); continue }
      // A 5xx can come after Drive made the folder or copy, so those POSTs are not repeated either.
      if (res.status >= 500 && retryNetwork && serverErrors < RETRIES - 1) { await this.wait(2 ** serverErrors++ * 500, more.cancelled); continue }
      if (res.status === 401) throw new SignInAgain()
      throw new DriveError(res.status, `Google Drive said ${res.status} to ${method} ${url.split('?')[0]}: ${(await res.text()).slice(0, 300)}`)
    }
  }

  /** `sleep`, ended early with Stopped when Stop is pressed. */
  protected async wait(ms: number, cancelled?: () => boolean): Promise<void> {
    if (!cancelled) return this.sleep(ms)
    let poll: ReturnType<typeof setInterval> | undefined
    try {
      await Promise.race([this.sleep(ms), new Promise<never>((_resolve, reject) => { poll = setInterval(() => { if (cancelled()) reject(new Stopped()) }, 100) })])
    } finally { clearInterval(poll) }
    stopIfAsked(cancelled)
  }
}

/** Drive answers a per-user or per-folder rate limit with 403 (not only 429); the reason is in the body. Other 403s are refusals. */
async function isRateLimit(res: Response): Promise<boolean> {
  try { return /userRateLimitExceeded|rateLimitExceeded|sharingRateLimitExceeded/.test(await res.clone().text()) } catch { return false }
}

export function splitPath(path: string): { parent: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { parent: '', name: path } : { parent: path.slice(0, i), name: path.slice(i + 1) }
}

/** A folder id from what was pasted: a bare id, or a drive.google.com/drive/folders/<id> link. */
export function folderIdFrom(text: string): string | null {
  const t = text.trim()
  const fromLink = /\/folders\/([\w-]+)/.exec(t)?.[1] ?? /[?&]id=([\w-]+)/.exec(t)?.[1]
  return fromLink ?? (/^[\w-]{10,}$/.test(t) ? t : null)
}

export const escapeQ = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

export function infoOf(path: string, f: DriveFile): FileInfo {
  return { path, size: Number(f.size ?? 0), modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : null, ...(f.sha256Checksum ? { sha256: f.sha256Checksum } : {}), ...(f.md5Checksum ? { md5: f.md5Checksum } : {}) }
}
