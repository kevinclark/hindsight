/**
 * A real ssh2 SFTP server on 127.0.0.1 for the robot-pull tests: user `lvuser` with an empty password (or keyboard-interactive,
 * as the roboRIO takes), serving invented files. On demand it holds a READ or READDIR unanswered (a link gone quiet), drops
 * the TCP connection mid-file, or ignores a new connection (a robot that does not answer a reconnect).
 */
import { generateKeyPairSync } from 'node:crypto'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { Server, utils } from 'ssh2'

const { STATUS_CODE } = utils.sftp

export type ReadVerdict = 'serve' | 'hold' | 'drop'
export interface ReadRequest { conn: number; path: string; offset: number }
export interface DirEntry { name: string; size?: number; isDir?: boolean; mtimeMs?: number }

export interface SftpServerOptions {
  files: Record<string, Uint8Array>
  dirs?: Record<string, DirEntry[]>
  /** Bytes answered per READ (a real server answers what was asked; small values make a short file span many reads). */
  chunk?: number
  /** Decides each READ; the default serves everything. `conn` counts connections from 1. */
  onRead?: (r: ReadRequest) => ReadVerdict
  onReaddir?: (conn: number, dir: string) => 'serve' | 'hold'
  /** 'ignore' leaves a new connection unanswered (no ssh handshake): a reconnect that hangs. */
  onConnect?: (conn: number) => 'accept' | 'ignore'
  /** A file's end as the server tells it on a connection: fewer bytes than the listing said (a copy cut short on the robot's side). */
  endOf?: (conn: number, path: string, size: number) => number
}

export interface SftpServer {
  port: number
  reads: ReadRequest[]
  connections: number
  /** Bytes the clients have sent so far, over all connections (an idle ssh client sends only keepalives). */
  bytesReceived(): number
  dropAll(): void
  close(): Promise<void>
}

/** One host key for the file's servers (RSA generation takes a moment). */
const HOST_KEY = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey

export async function startSftpServer(o: SftpServerOptions): Promise<SftpServer> {
  const ssh = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    const conn = state.connections
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'lvuser') return ctx.reject()
      if (ctx.method === 'password' && ctx.password === '') return ctx.accept()
      if (ctx.method === 'keyboard-interactive') return ctx.prompt([], () => ctx.accept())
      ctx.reject(['password', 'keyboard-interactive'])
    })
    client.on('ready', () => client.on('session', (accept) => {
      accept().on('sftp', (acceptSftp) => serve(acceptSftp(), conn))
    }))
  })
  const sockets = new Set<Socket>()
  const net: NetServer = createServer((socket) => {
    state.connections++
    const conn = state.connections
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (o.onConnect?.(conn) === 'ignore') return
    ssh.injectSocket(socket)
  })
  const state: SftpServer = {
    port: 0, reads: [], connections: 0,
    bytesReceived: () => [...sockets].reduce((n, x) => n + x.bytesRead, 0),
    dropAll: () => { for (const s of sockets) s.destroy() },
    close: () => new Promise<void>((resolve) => { state.dropAll(); net.close(() => resolve()); ssh.close() }),
  }

  function serve(sftp: import('ssh2').SFTPWrapper & { on: (e: string, f: (...a: never[]) => void) => unknown }, conn: number) {
    const handles = new Map<string, { path: string; dir: boolean; listed?: boolean }>()
    let next = 0
    const newHandle = (h: { path: string; dir: boolean }) => { const id = Buffer.from(`h${++next}`); handles.set(id.toString(), h); return id }
    const attrs = (size: number, dir: boolean, mtimeMs = 0) => ({ mode: dir ? 0o40755 : 0o100644, uid: 0, gid: 0, size, atime: Math.floor(mtimeMs / 1000), mtime: Math.floor(mtimeMs / 1000) })
    const on = (event: string, fn: (...a: any[]) => void) => sftp.on(event, fn as never)
    on('REALPATH', (id: number, path: string) => sftp.name(id, [{ filename: path, longname: path, attrs: attrs(0, true) }]))
    on('OPEN', (id: number, path: string) => (path in o.files ? sftp.handle(id, newHandle({ path, dir: false })) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)))
    on('OPENDIR', (id: number, path: string) => (o.dirs && path in o.dirs ? sftp.handle(id, newHandle({ path, dir: true })) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE)))
    on('READDIR', (id: number, handle: Buffer) => {
      const h = handles.get(handle.toString())
      if (!h) return sftp.status(id, STATUS_CODE.FAILURE)
      if (h.listed) return sftp.status(id, STATUS_CODE.EOF)
      if (o.onReaddir?.(conn, h.path) === 'hold') return // never answered
      h.listed = true
      sftp.name(id, (o.dirs?.[h.path] ?? []).map((e) => ({ filename: e.name, longname: e.name, attrs: attrs(e.size ?? 0, !!e.isDir, e.mtimeMs) })))
    })
    const stat = (id: number, path: string) => (path in o.files ? sftp.attrs(id, attrs(o.files[path].length, false)) : sftp.status(id, STATUS_CODE.NO_SUCH_FILE))
    on('STAT', stat)
    on('LSTAT', stat)
    on('FSTAT', (id: number, handle: Buffer) => { const h = handles.get(handle.toString()); if (h) stat(id, h.path); else sftp.status(id, STATUS_CODE.FAILURE) })
    on('READ', (id: number, handle: Buffer, offset: number, length: number) => {
      const h = handles.get(handle.toString())
      if (!h) return sftp.status(id, STATUS_CODE.FAILURE)
      const request = { conn, path: h.path, offset }
      state.reads.push(request)
      const verdict = o.onRead?.(request) ?? 'serve'
      if (verdict === 'hold') return
      if (verdict === 'drop') { state.dropAll(); return }
      const bytes = o.files[h.path]
      const end = o.endOf?.(conn, h.path, bytes.length) ?? bytes.length
      if (offset >= end) return sftp.status(id, STATUS_CODE.EOF)
      sftp.data(id, Buffer.from(bytes.subarray(offset, Math.min(end, offset + Math.min(length, o.chunk ?? length)))))
    })
    on('CLOSE', (id: number, handle: Buffer) => { handles.delete(handle.toString()); sftp.status(id, STATUS_CODE.OK) })
  }

  await new Promise<void>((resolve) => net.listen(0, '127.0.0.1', resolve))
  state.port = (net.address() as import('node:net').AddressInfo).port
  return state
}
