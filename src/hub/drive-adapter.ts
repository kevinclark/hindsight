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
import { API, FIELDS, FOLDER, RETRIES, DriveError, DriveReader, isReadOnlyRequest, infoOf, splitPath, type DriveFile, type DriveOptions } from './drive-read.ts'

const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
/** A multiple of 256 KiB, as Drive requires for all but the last chunk. */
const CHUNK = 8 << 20
export { DriveError, type DriveOptions }

export class DriveAdapter extends DriveReader implements StorageAdapter {
  /** Upload session addresses Drive gave us: the only places a PUT may go. */
  private sessions = new Set<string>()

  constructor(opts: DriveOptions) { super(opts) }

  // ---- StorageAdapter -------------------------------------------------------------------------------

  async read(path: string, start: number, end: number): Promise<Uint8Array> {
    const f = await this.find(path)
    if (!f) throw new Error(`${path} not found`)
    // A manifest or history file this process wrote or read whole, unchanged on Drive (same md5): no download.
    const key = `${this.opts.rootId}:${path}`
    const kept = isOwnAppendPath(path) ? manifestMemo.get(key) : undefined
    const whole = start === 0 && end >= Number(f.size ?? 0)
    if (kept !== undefined && whole && f.md5Checksum !== undefined && f.md5Checksum === md5Text(kept)) return new TextEncoder().encode(kept)
    const bytes = await this.fetchRange(f, start, end)
    if (whole && isOwnAppendPath(path) && f.md5Checksum !== undefined && createHash('md5').update(bytes).digest('hex') === f.md5Checksum) manifestMemo.set(key, new TextDecoder().decode(bytes))
    return bytes
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
    const key = `${this.opts.rootId}:${path}`
    if (existing) {
      // read() answers from the memo when Drive's md5 says the file is what this process last wrote or read.
      const size = Number(existing.size ?? 0)
      const have = size === 0 ? '' : new TextDecoder().decode(await this.read(path, 0, size))
      if (!extendsManifest(have, content)) throw new ManifestConflict(path)
      this.calls.upload++
      await this.request(`${UPLOAD}/files/${existing.id}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body })
      manifestMemo.set(key, content)
      return
    }
    await this.writeNew(path, { size: body.length, read: async (a, b) => body.subarray(a, b) })
    manifestMemo.set(key, content)
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

  protected override async createFolder(parentId: string, name: string): Promise<string> {
    const res = await this.request(`${API}/files?supportsAllDrives=true&fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }) })
    return ((await res.json()) as { id: string }).id
  }

  protected override allows(method: string, url: string): boolean {
    return isAllowedRequest(method, url, this.sessions)
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

}

/**
 * Every request the adapter may send. The OAuth scope `drive` can delete and trash anything, so the code itself is limited to
 * what the library needs: read, create a folder, create or copy a file, start and continue an upload, and update the
 * content of a manifest. No DELETE, no trashing, no metadata update (`trashed: true` is a metadata update), no permissions.
 */
export function isAllowedRequest(method: string, url: string, sessions: ReadonlySet<string> = new Set()): boolean {
  const u = url.split('?')[0]
  const files = `${API}/files`
  if (method === 'GET') return isReadOnlyRequest(method, url)
  if (method === 'POST') return u === files || (u.startsWith(`${files}/`) && /^[^/]+\/copy$/.test(u.slice(files.length + 1))) || (u === `${UPLOAD}/files` && url.includes('uploadType=resumable'))
  if (method === 'PUT') return sessions.has(url)
  if (method === 'PATCH') return u.startsWith(`${UPLOAD}/files/`) && url.includes('uploadType=media')
  return false
}

/**
 * Manifest and history text this process last wrote or read whole, by `${root folder id}:${path}`; shared by every
 * DriveAdapter (the app makes a new one per job). Used only when Drive's current md5 equals the memo's: a missing or
 * different md5 always downloads. Memory only, so the first read after launch downloads.
 */
const manifestMemo = new Map<string, string>()
const md5Text = (text: string) => createHash('md5').update(text).digest('hex')
