/**
 * The read half of the Drive client: list, stat and ranged read over fetch, with the retries, back-off and token refresh
 * every Drive call needs. The phone uses it alone (scope drive.readonly, nothing written); DriveAdapter extends it with
 * the writes. It sends GET and nothing else, and no `node:` module is imported here, so a phone build can bundle it.
 */
import { SignInAgain, checkPath, type FileInfo } from './adapter.ts'

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
  async read(path: string, start: number, end: number): Promise<Uint8Array> {
    const f = await this.find(path)
    if (!f) throw new Error(`${path} not found`)
    return this.fetchRange(f, start, end)
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

  /**
   * A whole file by one plain GET (no Range: Drive is reported to refuse Range on cross-origin requests from a page), its
   * bytes counted as they arrive into one buffer of the file's size, so a big log is held once. `signal` stops it; a stopped
   * or failed download starts again from zero.
   */
  async downloadWhole(path: string, opts: { onProgress?(got: number, total: number): void; signal?: AbortSignal } = {}): Promise<Uint8Array> {
    opts.signal?.throwIfAborted()
    const f = await this.find(path)
    if (!f) throw new Error(`${path} not found`)
    this.calls.download++
    const total = Number(f.size ?? 0)
    const res = await this.request(`${API}/files/${f.id}?alt=media&supportsAllDrives=true`, { signal: opts.signal })
    const out = new Uint8Array(total)
    let at = 0
    const take = (chunk: Uint8Array) => {
      if (at + chunk.length > total) throw new Error(`${path} is larger than Drive said (${total} bytes)`)
      out.set(chunk, at)
      at += chunk.length
      opts.onProgress?.(at, total)
    }
    if (!res.body) take(new Uint8Array(await res.arrayBuffer()))
    else for (const reader = res.body.getReader(); ; ) {
      if (opts.signal?.aborted) { await reader.cancel(); opts.signal.throwIfAborted() }
      const { done, value } = await reader.read()
      if (done) break
      take(value)
    }
    if (at !== total) throw new Error(`${path}: got ${at} of ${total} bytes`)
    return out
  }

  protected async fetchRange(f: DriveFile, start: number, end: number): Promise<Uint8Array> {
    this.calls.download++
    const res = await this.request(`${API}/files/${f.id}?alt=media&supportsAllDrives=true`, { headers: { Range: `bytes=${start}-${end - 1}` } })
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

  /** One authorised request with retries; throws DriveError for a refusal, SignInAgain when the token can't be renewed. */
  protected async request(url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    if (!this.allows(method, url)) throw new Error(`Hindsight never sends ${method} ${url.split('?')[0]} to Drive`)
    // Creating a folder or a copy is not repeated after a lost answer (the first may have worked): the caller looks first next time.
    const retryNetwork = method !== 'POST' || url.includes('uploadType=resumable')
    let refreshed = false
    // A wait between tries ends early when the caller stops (a download's Stop must not sit out a 30 s back-off).
    const signal = init.signal ?? undefined
    const wait = (ms: number) => !signal ? this.sleep(ms) : Promise.race([this.sleep(ms), new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })])
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      const token = await this.opts.token(refreshed)
      let res: Response
      try {
        res = await this.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } })
      } catch (e) {
        if (signal?.aborted || !retryNetwork || attempt >= RETRIES - 1) throw e
        await wait(2 ** attempt * 500)
        continue
      }
      if (res.ok || okStatuses.includes(res.status)) return res
      if (res.status === 401 && !refreshed) { refreshed = true; continue }
      const limited = res.status === 429 || (res.status === 403 && (await isRateLimit(res)))
      if (limited && attempt < RATE_RETRIES - 1) { await wait(Math.min(2 ** attempt, 30) * 1000 + Math.random() * 250); continue }
      // A 5xx can come after Drive made the folder or copy, so those POSTs are not repeated either.
      if (res.status >= 500 && retryNetwork && attempt < RETRIES - 1) { await wait(2 ** attempt * 500); continue }
      if (res.status === 401) throw new SignInAgain()
      throw new DriveError(res.status, `Google Drive said ${res.status} to ${method} ${url.split('?')[0]}: ${(await res.text()).slice(0, 300)}`)
    }
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
