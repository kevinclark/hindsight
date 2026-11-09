/**
 * A real HTTP server on 127.0.0.1 that answers the few Drive v3 requests a ranged read and a resumable upload make, and,
 * on demand, goes quiet or drops mid-body: the Drive adapter's own fetch talks to it over a real socket, so a stall, an
 * abort and a resume are the real thing. One file to read (`file`), one upload at a time. Invented bytes only.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/**
 * What to do with a request: answer it; hold it (headers and the first `after` bytes, then nothing); drop the connection
 * after `after` bytes; never answer; answer a status code; for a read, end cleanly after `after` bytes (`short`) or label
 * the bytes with the wrong range (`wrongRange`); for an upload, read it all but keep only `after` bytes (`partial`) or
 * read it at `rate` bytes a second (`slow`).
 */
export type Fault = { do: 'serve' } | { do: 'hold'; after: number } | { do: 'drop'; after: number } | { do: 'silent' } | { do: 'status'; code: number }
  | { do: 'short'; after: number } | { do: 'wrongRange' } | { do: 'partial'; after: number } | { do: 'slow'; rate: number }

export interface HttpDriveOptions {
  file: Uint8Array
  /** For each ranged GET of the file, by its start byte and how many came before it. */
  onRead?: (r: { start: number; n: number }) => Fault
  /** For each upload PUT with bytes, by its first byte and how many came before it: `after` is how much of the body the server reads. */
  onPut?: (r: { start: number; n: number }) => Fault
  /** For each upload status query ("bytes *" + "/total"), by how many came before it: 'serve' or 'drop'. */
  onStatus?: (r: { n: number }) => Fault
}

export interface HttpDrive {
  base: string
  /** "GET bytes=a-b" and "PUT bytes a-b/total" (a status query is "PUT bytes" then an asterisk and the total) in order. */
  log: string[]
  /** The finished upload's bytes, once Drive has them all. */
  uploaded: Uint8Array | null
  /** A `fetch` that sends the adapter's Google URLs here instead. */
  fetch: typeof fetch
  close(): Promise<void>
}

export async function startHttpDrive(o: HttpDriveOptions): Promise<HttpDrive> {
  const sockets = new Set<Socket>()
  let reads = 0
  let puts = 0
  let statuses = 0
  // The upload PUT still open, if any: Drive's answer to a status query is final, so that request is ended first.
  let open: IncomingMessage | null = null
  // The upload: what the server has kept (bytes it read off the socket before a request ended), as Drive keeps what it got.
  let total = 0
  let kept: Uint8Array[] = []
  let have = 0
  const me: HttpDrive = { base: '', log: [], uploaded: null, fetch: null as unknown as typeof fetch, close: async () => {} }
  const view = { id: 'f1', name: 'a.wpilog', mimeType: 'application/octet-stream', size: String(o.file.length) }

  const json = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }

  const read = (req: IncomingMessage, res: ServerResponse) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')!
    me.log.push(`GET ${m[0]}`)
    const start = Number(m[1])
    const body = o.file.subarray(start, Number(m[2]) + 1)
    const fault = o.onRead?.({ start, n: reads++ }) ?? { do: 'serve' }
    if (fault.do === 'silent') return // never answers: no headers at all
    if (fault.do === 'status') return json(res, { error: { code: fault.code } }, fault.code)
    const labelled = fault.do === 'wrongRange' ? 0 : start
    if (fault.do === 'short') { res.writeHead(206, { 'Content-Length': String(fault.after), 'Content-Range': `bytes ${start}-${start + fault.after - 1}/${o.file.length}` }); return res.end(body.subarray(0, fault.after)) }
    res.writeHead(206, { 'Content-Length': String(body.length), 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${labelled}-${labelled + body.length - 1}/${o.file.length}` })
    if (fault.do === 'serve' || fault.do === 'wrongRange') return res.end(body)
    if (fault.do !== 'hold' && fault.do !== 'drop') throw new Error(`no ${fault.do} for a read`)
    res.write(body.subarray(0, fault.after))
    if (fault.do === 'drop') setTimeout(() => res.socket?.destroy(), 50)
  }

  const put = (req: IncomingMessage, res: ServerResponse) => {
    const range = String(req.headers['content-range'] ?? '')
    me.log.push(`PUT ${range}`)
    const status = /^bytes \*\/(\d+)$/.exec(range)
    if (status) {
      open?.socket.destroy()
      open = null
      if ((o.onStatus?.({ n: statuses++ }) ?? { do: 'serve' }).do === 'drop') return req.socket.destroy()
      req.resume()
      return req.on('end', () => (have >= total ? json(res, done()) : res.writeHead(308, have ? { Range: `bytes=0-${have - 1}` } : {}).end()))
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)!
    const start = Number(m[1])
    if (start !== have) { req.resume(); return json(res, { error: { code: 400, message: `out of order: ${start}, have ${have}` } }, 400) }
    const fault = o.onPut?.({ start, n: puts++ }) ?? { do: 'serve' }
    open = req
    req.on('close', () => { if (open === req) open = null })
    if (fault.do === 'status') { req.resume(); return req.on('end', () => json(res, { error: { code: fault.code } }, fault.code)) }
    if (fault.do === 'slow') {
      req.pause()
      const tick = setInterval(() => { if (open !== req) return clearInterval(tick); for (let budget = Math.floor(fault.rate / 20), c: Buffer | null; budget > 0 && (c = req.read(Math.min(budget, 65536))); budget -= c.length) { kept.push(new Uint8Array(c)); have += c.length } }, 50)
      req.on('end', () => { clearInterval(tick); (have >= total ? json(res, done()) : res.writeHead(308, { Range: `bytes=0-${have - 1}` }).end()) })
      return req.on('close', () => clearInterval(tick))
    }
    if (fault.do === 'partial') {
      let taken = 0
      req.on('data', (c: Buffer) => { const part = c.subarray(0, Math.max(0, fault.after - taken)); taken += c.length; if (part.length) { kept.push(new Uint8Array(part)); have += part.length } })
      return req.on('end', () => res.writeHead(308, have ? { Range: `bytes=0-${have - 1}` } : {}).end())
    }
    const limit = fault.do === 'serve' ? Infinity : fault.do === 'silent' ? 0 : 'after' in fault ? fault.after : 0
    let taken = 0
    const take = (c: Buffer) => {
      if (open !== req) return
      const part = c.subarray(0, Math.max(0, limit - taken))
      if (part.length) { kept.push(new Uint8Array(part)); have += part.length; taken += part.length }
      if (taken >= limit) {
        req.off('data', take)
        req.pause() // stops reading: the client's sends back up and stall
        if (fault.do === 'drop') setTimeout(() => req.socket.destroy(), 50)
      }
    }
    req.on('data', take)
    req.on('end', () => { if (taken < limit || fault.do === 'serve') (have >= total ? json(res, done()) : res.writeHead(308, { Range: `bytes=0-${have - 1}` }).end()) })
  }

  const done = () => {
    const bytes = new Uint8Array(have)
    let at = 0
    for (const k of kept) { bytes.set(k, at); at += k.length }
    me.uploaded = bytes
    return { id: 'up1', name: 'up.wpilog', mimeType: 'application/octet-stream', size: String(bytes.length), md5Checksum: createHash('md5').update(bytes).digest('hex'), sha256Checksum: createHash('sha256').update(bytes).digest('hex') }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    const p = url.pathname
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      return json(res, { files: q.includes("mimeType = 'application/vnd.google-apps.folder'") ? [{ id: 'd1' }] : q.includes("name = 'a.wpilog'") ? [view] : [] })
    }
    if (p === '/drive/v3/files/f1' && url.searchParams.get('alt') === 'media') return read(req, res)
    if (p === '/upload/drive/v3/files' && req.method === 'POST') {
      total = Number(req.headers['x-upload-content-length'])
      kept = []; have = 0
      req.resume()
      return req.on('end', () => json(res, {}, 200, { Location: `${me.base}/session/1` }))
    }
    if (p === '/session/1' && req.method === 'PUT') return put(req, res)
    json(res, { error: { code: 404, message: `no ${req.method} ${p}` } }, 404)
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  me.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  me.fetch = (input, init) => globalThis.fetch(String(input).replace('https://www.googleapis.com', me.base), init)
  me.close = () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) })
  return me
}
