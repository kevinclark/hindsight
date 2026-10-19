/**
 * A minimal NetworkTables 4 server that replays a .wpilog as if it were the robot, so Foresight (which reads the
 * robot's live NT4 stream in the browser) can be tested without a robot. Test-only: it needs Node, `ws` and
 * `@msgpack/msgpack`, none of which ship in the app.
 *
 * Every log entry becomes a topic named prefix + log key (AdvantageKit publishes its log under /AdvantageKit).
 * Server time is robot time: a record logged at t seconds carries the NT timestamp round(t * 1e6) microseconds.
 * The replay clock runs at `speed` times wall time; every 20 ms each client is sent the records the clock has
 * passed, for the topics it subscribed to. Spec: https://github.com/wpilibsuite/allwpilib/blob/main/ntcore/doc/networktables4.adoc
 *
 * Differences from real ntcore (the server does not emulate them):
 *   - ALL records are sent. ntcore batches per the subscription's `periodic` (default 100 ms) and, unless `all` is
 *     true, sends only the latest value in each batch.
 *   - No publishing: `publish`, `setproperties` and the rest are recorded in `received` and ignored. Topics have
 *     empty properties, and the `$` meta-topics do not exist.
 *   - Topics are all announced to a client at subscribe time, never later (the log's topic set is fixed).
 *   - WebSocket ping/pong is left to the `ws` package; the RTT subprotocol is not offered.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import { decodeMulti, encode } from '@msgpack/msgpack'
import { openWpilog, readRaw, type WpilogFile } from '../../src/readers/wpilog.ts'

export interface ReplayOptions {
  /** The .wpilog. */
  bytes: Uint8Array
  /** 0 or undefined = pick a free port. */
  port?: number
  /** Default '/AdvantageKit': log key '/DriverStation/Enabled' becomes topic '/AdvantageKit/DriverStation/Enabled'. */
  prefix?: string
  /** Replay clock multiplier, default 1 (real time). */
  speed?: number
  /** Robot time (s) the replay clock starts at; default the log's first record time. */
  startAt?: number
  /** True: pretend the robot is in the pit: /DriverStation/FMSAttached is always false. */
  pit?: boolean
  /**
   * Also publish WPILib's /FMSInfo/FMSControlData (int, NOT under the prefix), synthesized from the log's
   * /DriverStation/Enabled (bit 0), /Autonomous (bit 1), /FMSAttached (bit 4, also forced 0 in pit mode) and
   * /DSAttached (bit 5), updated whenever any of those change. Default true.
   */
  fmsInfo?: boolean
}

export interface ReceivedFrame {
  kind: 'text' | 'binary'
  data: unknown
  /** Replay robot time (s) when it arrived. */
  at: number
}

export interface ReplayServer {
  port: number
  /** ws://127.0.0.1:<port>/nt/<clientName> */
  url: (clientName: string) => string
  /** Every frame any client sent: text frames parsed as JSON, binary frames decoded with decodeMulti. */
  received: ReceivedFrame[]
  /** Log entries not published because their type has no NT4 equivalent, as "name (type)". */
  skipped: string[]
  /** Current replay robot time in seconds. */
  now(): number
  close(): Promise<void>
}

const PROTOCOLS = ['v4.1.networktables.first.wpi.edu', 'networktables.first.wpi.edu']
const TICK_MS = 20
const FMS_TOPIC = '/FMSInfo/FMSControlData'
const FMS_BITS: [string, number][] = [['/DriverStation/Enabled', 0], ['/DriverStation/Autonomous', 1], ['/DriverStation/FMSAttached', 4], ['/DriverStation/DSAttached', 5]]

/** A published topic: its records' times (s, in time order) and a way to put record i on the wire. */
interface Topic {
  name: string
  id: number
  type: string
  typeIdx: number
  t: number[]
  /** The msgpack encoding of record i's value. */
  value: (i: number) => Uint8Array
}

interface Subscription { topics: string[]; prefix: boolean; topicsonly: boolean }

interface Client {
  ws: WebSocket
  subs: Map<number, Subscription>
  /** Topic id -> index of the next record not yet sent. Present once announced. */
  cursor: Map<number, number>
}

const ARRAY_TYPES: Record<string, [string, number]> = {
  'boolean[]': ['boolean[]', 16], 'double[]': ['double[]', 17], 'int64[]': ['int[]', 18], 'float[]': ['float[]', 19], 'string[]': ['string[]', 20],
}
const SCALAR_TYPES: Record<string, [string, number]> = {
  boolean: ['boolean', 0], double: ['double', 1], int64: ['int', 2], float: ['float', 3], string: ['string', 4], json: ['json', 4],
  raw: ['raw', 5], structschema: ['structschema', 5],
}

/** wpilog type -> [NT4 type string, NT4 type index], or null when NT4 has nothing for it. */
function mapType(t: string): [string, number] | null {
  if (t.startsWith('struct:')) return [t, 5]
  return SCALAR_TYPES[t] ?? ARRAY_TYPES[t] ?? null
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** A float64 (0xcb) or float32 (0xca) always on the wire as that width, even when the value is a whole number. */
function msgFloat(width: 4 | 8, x: number): Uint8Array {
  const out = new Uint8Array(1 + width)
  const d = new DataView(out.buffer)
  out[0] = width === 8 ? 0xcb : 0xca
  if (width === 8) d.setFloat64(1, x); else d.setFloat32(1, x)
  return out
}

function arrayHeader(n: number): Uint8Array {
  if (n < 16) return new Uint8Array([0x90 | n])
  const out = new Uint8Array(n < 65536 ? 3 : 5)
  out[0] = n < 65536 ? 0xdc : 0xdd
  if (n < 65536) new DataView(out.buffer).setUint16(1, n)
  else new DataView(out.buffer).setUint32(1, n)
  return out
}

/** Decode the packed little-endian items of an array payload. */
function items(type: string, p: Uint8Array): Uint8Array[] {
  const d = new DataView(p.buffer, p.byteOffset, p.byteLength)
  const n = (size: number) => Math.floor(p.length / size)
  const each = (size: number, f: (i: number) => Uint8Array) => Array.from({ length: n(size) }, (_, i) => f(i))
  switch (type) {
    case 'boolean[]': return each(1, (i) => encode(p[i] !== 0))
    case 'double[]': return each(8, (i) => msgFloat(8, d.getFloat64(i * 8, true)))
    case 'float[]': return each(4, (i) => msgFloat(4, d.getFloat32(i * 4, true)))
    case 'int64[]': return each(8, (i) => encode(Number(d.getBigInt64(i * 8, true))))
    default: return stringItems(p, d)
  }
}

/** string[]: a u32 count, then each string as a u32 length and UTF-8 bytes. */
function stringItems(p: Uint8Array, d: DataView): Uint8Array[] {
  const out: Uint8Array[] = []
  let pos = 4
  for (let i = 0, count = d.getUint32(0, true); i < count; i++) {
    const len = d.getUint32(pos, true)
    out.push(encode(new TextDecoder().decode(p.subarray(pos + 4, pos + 4 + len))))
    pos += 4 + len
  }
  return out
}

/** Turn one record's raw wpilog payload into the msgpack value NT4 sends for that type. */
function encodeValue(type: string, p: Uint8Array): Uint8Array {
  const d = new DataView(p.buffer, p.byteOffset, p.byteLength)
  switch (type) {
    case 'boolean': return encode(p[0] !== 0)
    case 'double': return msgFloat(8, d.getFloat64(0, true))
    case 'float': return msgFloat(4, d.getFloat32(0, true))
    case 'int64': return encode(Number(d.getBigInt64(0, true)))
    case 'string': case 'json': return encode(new TextDecoder().decode(p))
  }
  if (type.endsWith('[]') && !type.startsWith('struct:')) {
    const parts = items(type, p)
    return concat([arrayHeader(parts.length), ...parts])
  }
  return encode(p) // raw, structschema, struct:*: bin
}

/** How many records in sorted t are at or before x (the index of the first one the clock has not reached). */
function passed(t: number[], x: number): number {
  let lo = 0
  let hi = t.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= x) lo = mid + 1; else hi = mid
  }
  return lo
}

function matches(topic: Topic, sub: Subscription): boolean {
  return sub.topics.some((s) => (sub.prefix ? topic.name.startsWith(s) : topic.name === s))
}

/** The publishable topics for a log, and the entries that could not be mapped. */
function buildTopics(log: WpilogFile, options: ReplayOptions): { topics: Topic[]; skipped: string[] } {
  const prefix = options.prefix ?? '/AdvantageKit'
  const topics: Topic[] = []
  const skipped: string[] = []
  for (const [key, entry] of log.entries) {
    const mapped = mapType(entry.type)
    if (!mapped) { skipped.push(`${key} (${entry.type})`); continue }
    const raw = readRaw(log, key)!
    const forceFalse = options.pit && key === '/DriverStation/FMSAttached'
    topics.push({
      name: prefix + key, id: topics.length, type: mapped[0], typeIdx: mapped[1], t: raw.t,
      value: forceFalse ? () => encode(false) : (i) => encodeValue(entry.type, raw.payload[i]),
    })
  }
  if (options.fmsInfo !== false) {
    const fms = fmsTopic(log, options, topics.length)
    if (fms) topics.push(fms)
  }
  return { topics, skipped }
}

/** /FMSInfo/FMSControlData: one record each time the Enabled, Autonomous, FMSAttached or DSAttached value changes. */
function fmsTopic(log: WpilogFile, options: ReplayOptions, id: number): Topic | null {
  const changes: { t: number; bit: number; on: boolean }[] = []
  for (const [key, bit] of FMS_BITS) {
    const raw = readRaw(log, key)
    if (!raw) continue
    const pit = options.pit && bit === 4
    raw.t.forEach((t, i) => changes.push({ t, bit, on: !pit && raw.payload[i][0] !== 0 }))
  }
  if (changes.length === 0) return null
  changes.sort((a, b) => a.t - b.t)
  const t: number[] = []
  const words: number[] = []
  let word = 0
  for (const c of changes) {
    word = c.on ? word | (1 << c.bit) : word & ~(1 << c.bit)
    if (t.length > 0 && t[t.length - 1] === c.t) words[words.length - 1] = word
    else if (words.length === 0 || words[words.length - 1] !== word) { t.push(c.t); words.push(word) }
  }
  return { name: FMS_TOPIC, id, type: 'int', typeIdx: 2, t, value: (i) => encode(words[i]) }
}

/** One value as an NT4 binary message: [topicId, timestampUs, typeIdx, value]. */
function message(topic: Topic, i: number): Uint8Array {
  return concat([new Uint8Array([0x94]), encode(topic.id), encode(Math.round(topic.t[i] * 1e6)), encode(topic.typeIdx), topic.value(i)])
}

function parseText(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

export async function startReplayServer(options: ReplayOptions): Promise<ReplayServer> {
  const log = openWpilog(options.bytes)
  const { topics, skipped } = buildTopics(log, options)
  const speed = options.speed ?? 1
  const startAt = options.startAt ?? log.firstTime
  const wall0 = performance.now()
  const now = () => startAt + ((performance.now() - wall0) / 1000) * speed

  const received: ReceivedFrame[] = []
  const clients = new Set<Client>()

  const http: Server = createServer((_req, res) => { res.writeHead(404).end() })
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (offered) => PROTOCOLS.find((p) => offered.has(p)) ?? false })
  http.on('upgrade', (req, socket, head) => upgrade(req, socket, head))
  const ticker = setInterval(() => clients.forEach(tick), TICK_MS)

  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
    const protocol = PROTOCOLS.find((p) => offered.includes(p))
    if (!/^\/nt\/[^/]+$/.test(path) || !protocol) {
      socket.end(`HTTP/1.1 ${protocol ? 404 : 400} Rejected\r\nConnection: close\r\n\r\n`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws))
  }

  function connect(ws: WebSocket): void {
    const client: Client = { ws, subs: new Map(), cursor: new Map() }
    clients.add(client)
    ws.on('close', () => clients.delete(client))
    ws.on('message', (data, isBinary) => (isBinary ? onBinary(client, data) : onText(client, data.toString())))
  }

  function onText(client: Client, raw: string): void {
    const data = parseText(raw)
    received.push({ kind: 'text', data, at: now() })
    if (!Array.isArray(data)) return
    for (const msg of data) {
      const { method, params } = (msg ?? {}) as { method?: unknown; params?: Record<string, unknown> }
      if (method === 'subscribe' && params) subscribe(client, params)
      else if (method === 'unsubscribe' && params) client.subs.delete(params.subuid as number)
    }
  }

  function onBinary(client: Client, data: RawData): void {
    const bytes = new Uint8Array(Array.isArray(data) ? Buffer.concat(data) : (data as Buffer))
    const decoded = decodeMulti(bytes) as Iterable<unknown>
    const msgs = [...decoded]
    received.push({ kind: 'binary', data: msgs, at: now() })
    for (const m of msgs) {
      // RTT ping [-1, 0, type, clientTime]: answer with the server's time and the client's value, as the spec says
      if (Array.isArray(m) && m[0] === -1) client.ws.send(encode([-1, Math.round(now() * 1e6), 2, m[3]]))
    }
  }

  function subscribe(client: Client, params: Record<string, unknown>): void {
    const opts = (params.options ?? {}) as { prefix?: boolean; topicsonly?: boolean }
    const sub: Subscription = { topics: (params.topics as string[]) ?? [], prefix: !!opts.prefix, topicsonly: !!opts.topicsonly }
    client.subs.set(params.subuid as number, sub)
    const clock = now()
    const hits = topics.filter((t) => matches(t, sub))
    for (const t of hits) {
      if (!client.cursor.has(t.id)) {
        client.ws.send(JSON.stringify([{ method: 'announce', params: { name: t.name, id: t.id, type: t.type, properties: {} } }])) // a text frame is a JSON list
      }
    }
    for (const t of hits) {
      const upto = passed(t.t, clock)
      client.cursor.set(t.id, upto)
      if (!sub.topicsonly && upto > 0) client.ws.send(message(t, upto - 1))
    }
  }

  /** Send a client every record the clock has passed since the last tick, on topics it wants values for. */
  function tick(client: Client): void {
    const clock = now()
    const due: { t: number; topic: Topic; i: number }[] = []
    for (const topic of topics) {
      let i = client.cursor.get(topic.id)
      if (i === undefined) continue
      const wanted = [...client.subs.values()].some((s) => !s.topicsonly && matches(topic, s))
      for (; i < topic.t.length && topic.t[i] <= clock; i++) if (wanted) due.push({ t: topic.t[i], topic, i })
      client.cursor.set(topic.id, i)
    }
    if (due.length === 0) return
    due.sort((a, b) => a.t - b.t)
    client.ws.send(concat(due.map((d) => message(d.topic, d.i))))
  }

  await new Promise<void>((resolve) => http.listen(options.port ?? 0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  return {
    port, received, skipped, now,
    url: (name) => `ws://127.0.0.1:${port}/nt/${name}`,
    close: async () => {
      clearInterval(ticker)
      clients.forEach((c) => c.ws.terminate())
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections() })
    },
  }
}
