/**
 * The team's Google Drive as a StorageAdapter (Drive API v3 over fetch). Paths are folders and file names under one root
 * folder the user chose; Drive is id-based, so folder ids are looked up by name and remembered.
 *
 * No delete, no overwrite of a log: a log is created once through a resumable upload, which leaves no file until the last
 * byte arrives. Retries (429, 5xx, a dropped connection) resume the same upload session. Shared drives are included in
 * every request. A token the provider can no longer renew throws SignInAgain.
 */
import { createHash } from 'node:crypto'
import { AlreadyExists, ChecksumMismatch, ManifestConflict, SignInAgain, checkPath, extendsManifest, isOwnAppendPath, type ByteSource, type FileInfo, type StorageAdapter, type WriteOptions } from './adapter.ts'

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER = 'application/vnd.google-apps.folder'
const FIELDS = 'id,name,mimeType,size,modifiedTime,md5Checksum,sha256Checksum'
/** A multiple of 256 KiB, as Drive requires for all but the last chunk. */
const CHUNK = 8 << 20
const RETRIES = 5
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

interface DriveFile { id: string; name: string; mimeType: string; size?: string; modifiedTime?: string; md5Checksum?: string; sha256Checksum?: string }

export class DriveError extends Error {
  readonly status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export class DriveAdapter implements StorageAdapter {
  private readonly opts: DriveOptions
  private readonly fetch: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  /** path → folder id. */
  private folders = new Map<string, string>()
  /** Logs are never rewritten, so a log's file is remembered by path (a manifest changes, so it is looked up each time). */
  private logs = new Map<string, DriveFile>()
  /** Upload session addresses Drive gave us: the only places a PUT may go. */
  private sessions = new Set<string>()
  /** Counts of calls by kind, for the dry run's cost and the tests. */
  readonly calls = { list: 0, upload: 0, download: 0, copy: 0 }

  constructor(opts: DriveOptions) {
    this.opts = opts
    this.fetch = opts.fetch ?? globalThis.fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.folders.set('', opts.rootId)
  }

  // ---- StorageAdapter -------------------------------------------------------------------------------

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

  async read(path: string, start: number, end: number): Promise<Uint8Array> {
    const f = await this.find(path)
    if (!f) throw new Error(`${path} not found`)
    this.calls.download++
    const res = await this.request(`${API}/files/${f.id}?alt=media&supportsAllDrives=true`, { headers: { Range: `bytes=${start}-${end - 1}` } })
    return new Uint8Array(await res.arrayBuffer())
  }

  async writeNew(path: string, from: ByteSource, options: WriteOptions = {}): Promise<FileInfo> {
    const { parent, name } = splitPath(checkPath(path))
    if (await this.find(path)) throw new AlreadyExists(path)
    const parentId = (await this.folderId(parent, true))!
    const md5 = createHash('md5')
    const sha = createHash('sha256')
    const metadata = JSON.stringify({ name, parents: [parentId], ...(options.modifiedTime ? { modifiedTime: new Date(options.modifiedTime).toISOString() } : {}) })
    const session = await this.request(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${FIELDS}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(from.size) }, body: metadata,
    })
    const uri = session.headers.get('location')
    if (!uri) throw new DriveError(0, 'Drive gave no upload address')
    this.sessions.add(uri)
    this.calls.upload++
    let created: DriveFile | null = null
    if (from.size === 0) created = await this.put(uri, new Uint8Array(0), `bytes */0`)
    for (let at = 0; created === null; at += CHUNK) {
      if (at >= from.size && from.size > 0) throw new DriveError(0, 'Drive did not finish the file after its last byte')
      const chunk = await from.read(at, Math.min(from.size, at + CHUNK))
      md5.update(chunk); sha.update(chunk)
      created = await this.putChunk(uri, chunk, at, from.size)
      options.onProgress?.(Math.min(from.size, at + CHUNK), from.size)
    }
    return this.verify(path, created, options, md5.digest('hex'), sha.digest('hex'))
  }

  async appendManifest(path: string, content: string): Promise<void> {
    if (!isOwnAppendPath(checkPath(path))) throw new Error(`${path} is not a file this machine appends to`)
    const existing = await this.find(path)
    const body = new TextEncoder().encode(content)
    if (existing) {
      const size = Number(existing.size ?? 0)
      const have = size === 0 ? '' : new TextDecoder().decode(await this.read(path, 0, size))
      if (!extendsManifest(have, content)) throw new ManifestConflict(path)
      this.calls.upload++
      await this.request(`${UPLOAD}/files/${existing.id}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body })
      return
    }
    await this.writeNew(path, { size: body.length, read: async (a, b) => body.subarray(a, b) })
  }

  // ---- Drive-only helpers ------------------------------------------------------------------------------

  /** A file by its id, for a Drive folder that is not the library's (the ingest source). */
  async childrenOf(folderId: string): Promise<{ id: string; name: string; isFolder: boolean; size: number; modifiedTime: number | null; sha256?: string; md5?: string }[]> {
    return (await this.children(folderId)).map((f) => ({ id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, size: Number(f.size ?? 0), modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : null, sha256: f.sha256Checksum, md5: f.md5Checksum }))
  }

  /** The bytes of a file by id, into a sink in ranges (a download to disk). */
  async download(fileId: string, size: number, sink: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    for (let at = 0; at < size; at += CHUNK) {
      this.calls.download++
      const res = await this.request(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Range: `bytes=${at}-${Math.min(size, at + CHUNK) - 1}` } })
      await sink(new Uint8Array(await res.arrayBuffer()))
    }
  }

  /** Copy a file by id into the library at `path`, inside Drive (nothing is uploaded). */
  async copyInto(fileId: string, path: string): Promise<FileInfo> {
    const { parent, name } = splitPath(checkPath(path))
    if (await this.find(path)) throw new AlreadyExists(path)
    const parentId = (await this.folderId(parent, true))!
    this.calls.copy++
    const res = await this.request(`${API}/files/${fileId}/copy?supportsAllDrives=true&fields=${FIELDS}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parents: [parentId] }),
    })
    return infoOf(path, (await res.json()) as DriveFile)
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

  // ---- internals ----------------------------------------------------------------------------------------

  private async children(folderId: string): Promise<DriveFile[]> {
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

  private async find(path: string): Promise<DriveFile | null> {
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

  /** The id of the folder at `path` under the root; created (each part, once) when `create`, else null if missing. */
  private async folderId(path: string, create: boolean): Promise<string | null> {
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
    if (!id && create) {
      const res = await this.request(`${API}/files?supportsAllDrives=true&fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [above] }) })
      id = ((await res.json()) as { id: string }).id
    }
    if (id) this.folders.set(path, id)
    return id
  }

  /** One chunk of a resumable upload; after a failure, asks Drive how much it has and continues from there. */
  private async putChunk(uri: string, chunk: Uint8Array, at: number, total: number): Promise<DriveFile | null> {
    const range = `bytes ${at}-${at + chunk.length - 1}/${total}`
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.put(uri, chunk, range)
      } catch (e) {
        if (e instanceof SignInAgain || attempt >= RETRIES - 1 || (e instanceof DriveError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 408)) throw e
        await this.sleep(2 ** attempt * 500)
        // Ask Drive how much it kept: the whole chunk (go on), none of it (send it again) or something between (give up: the file is started again).
        const got = await this.sessionStatus(uri, total).catch((statusError) => { if (statusError instanceof SignInAgain) throw statusError; return null })
        if (got === null) continue // the question failed too: wait, then ask again with the next attempt
        if (got.file) return got.file
        if (got.next === at + chunk.length) return null
        if (got.next !== at) throw new DriveError(0, `the upload stopped at byte ${got.next} of a chunk starting at ${at}; start the file again`)
      }
    }
  }

  /** PUT bytes to an upload session: the finished file on 200/201, null on 308 (more wanted). */
  private async put(uri: string, body: Uint8Array, contentRange: string): Promise<DriveFile | null> {
    const res = await this.request(uri, { method: 'PUT', headers: { 'Content-Range': contentRange }, body: body as unknown as BodyInit }, [308])
    return res.status === 308 ? null : ((await res.json()) as DriveFile)
  }

  private async sessionStatus(uri: string, total: number): Promise<{ next: number; file?: DriveFile }> {
    const res = await this.request(uri, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } }, [308])
    if (res.status !== 308) return { next: total, file: (await res.json()) as DriveFile }
    const m = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '')
    return { next: m ? Number(m[1]) + 1 : 0 }
  }

  /** The file Drive made must be the file we sent: its checksums are compared with what we computed while sending. */
  private verify(path: string, file: DriveFile, options: WriteOptions, md5: string, sha256: string): FileInfo {
    if (file.md5Checksum && file.md5Checksum !== md5) throw new ChecksumMismatch(path, md5, file.md5Checksum)
    if (file.sha256Checksum && file.sha256Checksum !== sha256) throw new ChecksumMismatch(path, sha256, file.sha256Checksum)
    if (options.sha256 && options.sha256 !== sha256) throw new ChecksumMismatch(path, options.sha256, sha256)
    return infoOf(path, file)
  }

  /** One authorised request with retries; throws DriveError for a refusal, SignInAgain when the token can't be renewed. */
  private async request(url: string, init: RequestInit = {}, okStatuses: number[] = []): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    if (!isAllowedRequest(method, url, this.sessions)) throw new Error(`Hindsight never sends ${method} ${url.split('?')[0]} to Drive`)
    // Creating a folder or a copy is not repeated after a lost answer (the first may have worked): the caller looks first next time.
    const retryNetwork = method !== 'POST' || url.includes('uploadType=resumable')
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.opts.token(refreshed)
      let res: Response
      try {
        res = await this.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } })
      } catch (e) {
        if (!retryNetwork || attempt >= RETRIES - 1) throw e
        await this.sleep(2 ** attempt * 500)
        continue
      }
      if (res.ok || okStatuses.includes(res.status)) return res
      if (res.status === 401 && !refreshed) { refreshed = true; continue }
      const limited = res.status === 429 || (res.status === 403 && (await isRateLimit(res)))
      if (limited && attempt < RATE_RETRIES - 1) { await this.sleep(Math.min(2 ** attempt, 30) * 1000 + Math.random() * 250); continue }
      // A 5xx can come after Drive made the folder or copy, so those POSTs are not repeated either.
      if (res.status >= 500 && retryNetwork && attempt < RETRIES - 1) { await this.sleep(2 ** attempt * 500); continue }
      if (res.status === 401) throw new SignInAgain()
      throw new DriveError(res.status, `Google Drive said ${res.status} to ${method} ${url.split('?')[0]}: ${(await res.text()).slice(0, 300)}`)
    }
  }
}

/**
 * Every request the adapter may send. The OAuth scope `drive` can delete and trash anything, so the code itself is limited to
 * what the library needs: read, create a folder, create or copy a file, start and continue an upload, and update the
 * content of a manifest. No DELETE, no trashing, no metadata update (`trashed: true` is a metadata update), no permissions.
 */
export function isAllowedRequest(method: string, url: string, sessions: ReadonlySet<string> = new Set()): boolean {
  const u = url.split('?')[0]
  const files = `${API}/files`
  if (method === 'GET') return u === files || u === `${API}/drives` || (u.startsWith(`${files}/`) && !u.slice(files.length + 1).includes('/'))
  if (method === 'POST') return u === files || (u.startsWith(`${files}/`) && /^[^/]+\/copy$/.test(u.slice(files.length + 1))) || (u === `${UPLOAD}/files` && url.includes('uploadType=resumable'))
  if (method === 'PUT') return sessions.has(url)
  if (method === 'PATCH') return u.startsWith(`${UPLOAD}/files/`) && url.includes('uploadType=media')
  return false
}

/** Drive answers a per-user or per-folder rate limit with 403 (not only 429); the reason is in the body. Other 403s are refusals. */
async function isRateLimit(res: Response): Promise<boolean> {
  try { return /userRateLimitExceeded|rateLimitExceeded|sharingRateLimitExceeded/.test(await res.clone().text()) } catch { return false }
}

function splitPath(path: string): { parent: string; name: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { parent: '', name: path } : { parent: path.slice(0, i), name: path.slice(i + 1) }
}

const escapeQ = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

function infoOf(path: string, f: DriveFile): FileInfo {
  return { path, size: Number(f.size ?? 0), modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : null, ...(f.sha256Checksum ? { sha256: f.sha256Checksum } : {}), ...(f.md5Checksum ? { md5: f.md5Checksum } : {}) }
}
