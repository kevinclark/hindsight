/**
 * A stand-in for the parts of the Google Drive API v3 that DriveAdapter uses, as a `fetch`: folders and files by id,
 * listing with paging, ranged reads, resumable uploads with status queries, server-side copy, media updates, and
 * faults (a dropped connection, a refused token). Built from Google's documented shapes, then compared with the live API at
 * live step 2 (2026-10-22): folder create, listing with allDrives, resumable upload, in-place manifest update and ranged reads
 * behaved as modelled. Live Google also answered one request with 403 userRateLimitExceeded (tests/hub-drive.test.ts builds that answer).
 */
import { createHash, randomUUID } from 'node:crypto'

const FOLDER = 'application/vnd.google-apps.folder'

interface Node { id: string; name: string; mimeType: string; parents: string[]; bytes?: Uint8Array; modifiedTime: string; trashed: boolean }
interface Upload { id: string; name: string; parent: string; modifiedTime?: string; received: Uint8Array[]; got: number; total: number; failAfter: number | null }

export class FakeDrive {
  nodes = new Map<string, Node>()
  uploads = new Map<string, Upload>()
  /** Every request as "METHOD path", in order. */
  log: string[] = []
  /** Files returned per page (small, to make listing page). */
  pageSize = 2
  /** The token the API accepts; any other gets 401. */
  validToken = 'good'
  /** The next upload fails permanently once this many bytes have arrived. */
  failNextUploadAfter: number | null = null
  /** The next PUT of a chunk is dropped once (the connection resets before Drive keeps it). */
  dropNextChunk = false
  /** Leave sha256Checksum out of answers (Drive: "if available"). */
  withoutSha256 = false
  /** Store this instead of what was uploaded (a corrupted upload). */
  corruptNextUpload = false
  private clock = Date.UTC(2026, 9, 1)

  constructor() { this.nodes.set('root', { id: 'root', name: 'team', mimeType: FOLDER, parents: [], modifiedTime: new Date(this.clock).toISOString(), trashed: false }) }

  /** Put a file under a folder as if someone had uploaded it (for the Drive-folder ingest). */
  addFile(parent: string, name: string, bytes: Uint8Array | string, modifiedTime = new Date(this.clock++).toISOString()): string {
    const id = `f${this.nodes.size}-${randomUUID().slice(0, 4)}`
    this.nodes.set(id, { id, name, mimeType: 'application/octet-stream', parents: [parent], bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes, modifiedTime, trashed: false })
    return id
  }
  addFolder(parent: string, name: string): string {
    const id = `d${this.nodes.size}-${randomUUID().slice(0, 4)}`
    this.nodes.set(id, { id, name, mimeType: FOLDER, parents: [parent], modifiedTime: new Date(this.clock++).toISOString(), trashed: false })
    return id
  }
  /** The file at a path under the root, or undefined. */
  at(path: string): Node | undefined {
    let parent = 'root'
    let found: Node | undefined
    for (const part of path.split('/')) {
      found = [...this.nodes.values()].find((n) => n.parents[0] === parent && n.name === part && !n.trashed)
      if (!found) return undefined
      parent = found.id
    }
    return found
  }

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers as Record<string, string>)
    this.log.push(`${method} ${url.pathname}${url.searchParams.get('uploadType') ? `?${url.searchParams.get('uploadType')}` : ''}`)
    if (headers.get('authorization') !== `Bearer ${this.validToken}`) return json({ error: { code: 401, message: 'Invalid Credentials' } }, 401)
    const body = init.body === undefined ? undefined : typeof init.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array(init.body as ArrayBuffer)
    const p = url.pathname

    if (p.startsWith('/session/')) return this.putSession(p.slice('/session/'.length), method, headers, body ?? new Uint8Array(0))
    if (p === '/upload/drive/v3/files' && url.searchParams.get('uploadType') === 'resumable') return this.startUpload(headers, body!)
    let m: RegExpExecArray | null
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      const n = this.nodes.get(m[1])
      if (!n) return json({}, 404)
      n.bytes = body ?? new Uint8Array(0)
      n.modifiedTime = new Date(this.clock++).toISOString()
      return json(this.view(n))
    }
    if (p === '/drive/v3/drives') return json({ drives: [{ id: 'sd1', name: 'Shared one' }] })
    if (p === '/drive/v3/files' && method === 'GET') return this.list(url)
    if (p === '/drive/v3/files' && method === 'POST') {
      const meta = JSON.parse(new TextDecoder().decode(body))
      const id = meta.mimeType === FOLDER ? this.addFolder(meta.parents[0], meta.name) : this.addFile(meta.parents[0], meta.name, '')
      return json({ id })
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(p))) {
      const src = this.nodes.get(m[1])
      if (!src?.bytes) return json({}, 404)
      const meta = JSON.parse(new TextDecoder().decode(body))
      const id = this.addFile(meta.parents[0], meta.name, src.bytes, src.modifiedTime)
      return json(this.view(this.nodes.get(id)!))
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
      const n = this.nodes.get(m[1])
      if (!n || n.trashed) return json({ error: { code: 404 } }, 404)
      if (url.searchParams.get('alt') !== 'media') return json(this.view(n))
      const range = /bytes=(\d+)-(\d+)/.exec(headers.get('range') ?? '')
      const bytes = n.bytes ?? new Uint8Array(0)
      return new Response((range ? bytes.slice(Number(range[1]), Number(range[2]) + 1) : bytes) as unknown as BodyInit, { status: range ? 206 : 200 })
    }
    return json({ error: { code: 404, message: `fake drive has no ${method} ${p}` } }, 404)
  }

  private view(n: Node) {
    return {
      id: n.id, name: n.name, mimeType: n.mimeType, modifiedTime: n.modifiedTime,
      ...(n.bytes ? { size: String(n.bytes.length), md5Checksum: createHash('md5').update(n.bytes).digest('hex'), ...(this.withoutSha256 ? {} : { sha256Checksum: createHash('sha256').update(n.bytes).digest('hex') }) } : {}),
    }
  }

  private list(url: URL): Response {
    const q = url.searchParams.get('q') ?? ''
    const parent = /'([^']+)' in parents/.exec(q)?.[1]
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1')
    const mime = /mimeType = '([^']+)'/.exec(q)?.[1]
    const all = [...this.nodes.values()].filter((n) => !n.trashed && (!parent || n.parents.includes(parent)) && (name === undefined || n.name === name) && (!mime || n.mimeType === mime))
      .sort((a, b) => a.name.localeCompare(b.name))
    const start = Number(url.searchParams.get('pageToken') ?? 0)
    const page = all.slice(start, start + this.pageSize)
    return json({ files: page.map((n) => this.view(n)), ...(start + this.pageSize < all.length ? { nextPageToken: String(start + this.pageSize) } : {}) })
  }

  private startUpload(headers: Headers, body: Uint8Array): Response {
    const meta = JSON.parse(new TextDecoder().decode(body))
    const id = randomUUID()
    this.uploads.set(id, { id, name: meta.name, parent: meta.parents[0], modifiedTime: meta.modifiedTime, received: [], got: 0, total: Number(headers.get('x-upload-content-length')), failAfter: this.failNextUploadAfter })
    this.failNextUploadAfter = null
    return new Response('{}', { status: 200, headers: { Location: `https://upload.fake/session/${id}` } })
  }

  private putSession(id: string, method: string, headers: Headers, body: Uint8Array): Response {
    const u = this.uploads.get(id)
    if (!u) return json({}, 404)
    const range = headers.get('content-range') ?? ''
    if (u.failAfter !== null && u.got + body.length > u.failAfter) throw new TypeError('fetch failed')
    if (range.startsWith('bytes */') && body.length === 0 && u.total > 0) {
      return new Response(null, { status: 308, headers: u.got ? { Range: `bytes=0-${u.got - 1}` } : {} })
    }
    if (this.dropNextChunk && body.length > 0) { this.dropNextChunk = false; throw new TypeError('fetch failed') }
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)
    if (m) {
      if (Number(m[1]) !== u.got) return json({ error: { code: 400, message: 'out of order' } }, 400)
      u.received.push(body)
      u.got += body.length
    }
    if (u.got < u.total) return new Response(null, { status: 308, headers: { Range: `bytes=0-${u.got - 1}` } })
    const bytes = new Uint8Array(u.total)
    let at = 0
    for (const part of u.received) { bytes.set(part, at); at += part.length }
    if (this.corruptNextUpload) { this.corruptNextUpload = false; bytes[0] ^= 0xff }
    const nodeId = this.addFile(u.parent, u.name, bytes, u.modifiedTime)
    this.uploads.delete(id)
    return json(this.view(this.nodes.get(nodeId)!), 200)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
