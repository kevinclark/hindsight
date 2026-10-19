/**
 * Reader for WPILib .wpilog files (the format AdvantageKit writes).
 *
 * Format spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc
 *
 * The file is a header followed by records. Each record belongs to an "entry" (a signal such as
 * /SystemStats/BatteryVoltage). Entry 0 is the control channel: it announces each entry's name and type.
 *
 * Reading is in two steps so a 56 MB log stays fast:
 *   1. openWpilog() walks every record header once and remembers where each entry's records are.
 *   2. readNumbers() / readValues() decode only the entries a rule asks for.
 *
 * Values are logged only when they change. To get a value at a time, hold the last value (see match/series.ts);
 * never interpolate between records.
 */

import type { NumberSeries, ValueSeries } from '../match/series.ts'

export interface WpilogEntry {
  id: number
  name: string
  type: string
  metadata: string
}

export interface WpilogFile {
  bytes: Uint8Array
  view: DataView
  /** Entries by name. */
  entries: Map<string, WpilogEntry>
  /** Total data records (not counting control records). */
  recordCount: number
  /** For entry id e, its records' header positions are recordPos[entryStart[e] .. entryStart[e + 1]). */
  entryStart: Uint32Array
  recordPos: Uint32Array
  /** Problems found while reading (a truncated last record, a reused entry id). Shown in the report. */
  warnings: string[]
}

export interface Pose2d { x: number; y: number; rot: number }
export interface ChassisSpeeds { vx: number; vy: number; omega: number }

const utf8 = new TextDecoder('utf-8')

/** One record header, read at `pos`. Returns null when the file ends mid-record. */
interface RecordHeader { entryId: number; size: number; timestampUs: number; payloadPos: number }

function readHeader(bytes: Uint8Array, pos: number): RecordHeader | null {
  if (pos >= bytes.length) return null
  const bitfield = bytes[pos]
  const idLen = (bitfield & 0x3) + 1
  const sizeLen = ((bitfield >> 2) & 0x3) + 1
  const tsLen = ((bitfield >> 4) & 0x7) + 1
  let p = pos + 1
  if (p + idLen + sizeLen + tsLen > bytes.length) return null
  const entryId = readUintLE(bytes, p, idLen); p += idLen
  const size = readUintLE(bytes, p, sizeLen); p += sizeLen
  const timestampUs = readUintLE(bytes, p, tsLen); p += tsLen
  if (p + size > bytes.length) return null
  return { entryId, size, timestampUs, payloadPos: p }
}

/** Little-endian unsigned integer of 1–8 bytes. Timestamps up to 2^53 µs are exact in a JS number. */
function readUintLE(bytes: Uint8Array, pos: number, len: number): number {
  let value = 0
  let scale = 1
  for (let i = 0; i < len; i++) {
    value += bytes[pos + i] * scale
    scale *= 256
  }
  return value
}

/** Index a .wpilog. Throws if the file isn't a wpilog. */
export function openWpilog(bytes: Uint8Array): WpilogFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = utf8.decode(bytes.subarray(0, 6))
  if (magic !== 'WPILOG') throw new Error('Not a .wpilog file (missing WPILOG header)')
  const version = view.getUint16(6, true)
  if (version >> 8 !== 1) throw new Error(`Unsupported wpilog version 0x${version.toString(16)}`)
  const extraLen = view.getUint32(8, true)
  const firstRecord = 12 + extraLen
  const warnings: string[] = []

  // Pass 1: announce entries, count records per entry.
  const entries = new Map<string, WpilogEntry>()
  const nameById = new Map<number, string>()
  let counts = new Uint32Array(1024)
  let maxId = 0
  let recordCount = 0
  let pos = firstRecord
  while (pos < bytes.length) {
    const h = readHeader(bytes, pos)
    if (!h) { warnings.push(`Log ends mid-record at byte ${pos} of ${bytes.length} (robot lost power?)`); break }
    if (h.entryId === 0) {
      readControlRecord(bytes, view, h, entries, nameById, warnings)
    } else {
      if (h.entryId >= counts.length) {
        const bigger = new Uint32Array(Math.max(h.entryId + 1, counts.length * 2))
        bigger.set(counts)
        counts = bigger
      }
      counts[h.entryId]++
      if (h.entryId > maxId) maxId = h.entryId
      recordCount++
    }
    pos = h.payloadPos + h.size
  }

  // Pass 2: put each entry's record positions next to each other (a counting sort).
  const entryStart = new Uint32Array(maxId + 2)
  for (let e = 0; e <= maxId; e++) entryStart[e + 1] = entryStart[e] + counts[e]
  const fill = entryStart.slice(0, maxId + 1)
  const recordPos = new Uint32Array(recordCount)
  pos = firstRecord
  while (pos < bytes.length) {
    const h = readHeader(bytes, pos)
    if (!h) break
    if (h.entryId !== 0) recordPos[fill[h.entryId]++] = pos
    pos = h.payloadPos + h.size
  }

  return { bytes, view, entries, recordCount, entryStart, recordPos, warnings }
}

function readControlRecord(
  bytes: Uint8Array, view: DataView, h: RecordHeader,
  entries: Map<string, WpilogEntry>, nameById: Map<number, string>, warnings: string[],
): void {
  const p = h.payloadPos
  if (h.size < 5 || bytes[p] !== 0) return // only "Start" (0) matters; Finish (1) and SetMetadata (2) are ignored
  const id = view.getUint32(p + 1, true)
  let q = p + 5
  const readString = (): string => {
    const len = view.getUint32(q, true)
    const s = utf8.decode(bytes.subarray(q + 4, q + 4 + len))
    q += 4 + len
    return s
  }
  const name = readString()
  const type = readString()
  const metadata = readString()
  const previous = nameById.get(id)
  if (previous !== undefined && previous !== name) {
    warnings.push(`Entry id ${id} reused (${previous} → ${name}); only the first name is read`)
    return
  }
  nameById.set(id, name)
  if (!entries.has(name)) entries.set(name, { id, name, type, metadata })
}

/** True when the log has this entry with at least one record. */
export function hasEntry(log: WpilogFile, name: string): boolean {
  const e = log.entries.get(name)
  return !!e && log.entryStart[e.id + 1] > log.entryStart[e.id]
}

/** Visit each record of one entry: timestamp in seconds, payload position and size. */
function forEachRecord(log: WpilogFile, entry: WpilogEntry, visit: (t: number, pos: number, size: number) => void): void {
  const from = log.entryStart[entry.id] ?? 0
  const to = log.entryStart[entry.id + 1] ?? 0
  for (let i = from; i < to; i++) {
    const h = readHeader(log.bytes, log.recordPos[i])!
    visit(h.timestampUs / 1e6, h.payloadPos, h.size)
  }
}

/**
 * Read a numeric signal: double, float, int64, boolean (0/1) or struct:Rotation2d (radians).
 * Returns null when the entry is missing, so a rule can report "not checked" instead of failing.
 */
export function readNumbers(log: WpilogFile, name: string): NumberSeries | null {
  const entry = log.entries.get(name)
  if (!entry) return null
  const decode = numberDecoder(log, entry.type)
  if (!decode) throw new Error(`${name} has type ${entry.type}, which is not a single number`)
  const n = (log.entryStart[entry.id + 1] ?? 0) - (log.entryStart[entry.id] ?? 0)
  const t = new Float64Array(n)
  const v = new Float64Array(n)
  let i = 0
  forEachRecord(log, entry, (time, pos, size) => {
    const value = decode(pos, size)
    if (value === null) return
    t[i] = time
    v[i] = value
    i++
  })
  return { name, t: t.subarray(0, i), v: v.subarray(0, i) }
}

function numberDecoder(log: WpilogFile, type: string): ((pos: number, size: number) => number | null) | null {
  const view = log.view
  switch (type) {
    case 'double':
    case 'struct:Rotation2d':
      return (pos, size) => (size === 8 ? view.getFloat64(pos, true) : null)
    case 'float':
      return (pos, size) => (size === 4 ? view.getFloat32(pos, true) : null)
    case 'int64':
      return (pos, size) => (size === 8 ? Number(view.getBigInt64(pos, true)) : null)
    case 'boolean':
      return (pos, size) => (size >= 1 ? (log.bytes[pos] !== 0 ? 1 : 0) : null)
    default:
      return null
  }
}

/** Read any supported signal as plain JS values (strings, arrays, structs). Null when missing. */
export function readValues<T = unknown>(log: WpilogFile, name: string): ValueSeries<T> | null {
  const entry = log.entries.get(name)
  if (!entry) return null
  const t: number[] = []
  const v: T[] = []
  forEachRecord(log, entry, (time, pos, size) => {
    const value = decodeValue(log, entry.type, pos, size)
    if (value === undefined) return
    t.push(time)
    v.push(value as T)
  })
  return { name, t: Float64Array.from(t), v }
}

/** Fixed-size structs we know how to read. Field order follows WPILib's struct schemas. */
const STRUCTS: Record<string, { size: number; read: (view: DataView, pos: number) => unknown }> = {
  Rotation2d: { size: 8, read: (d, p) => d.getFloat64(p, true) },
  Translation2d: { size: 16, read: (d, p) => ({ x: d.getFloat64(p, true), y: d.getFloat64(p + 8, true) }) },
  Pose2d: {
    size: 24,
    read: (d, p): Pose2d => ({ x: d.getFloat64(p, true), y: d.getFloat64(p + 8, true), rot: d.getFloat64(p + 16, true) }),
  },
  ChassisSpeeds: {
    size: 24,
    read: (d, p): ChassisSpeeds => ({ vx: d.getFloat64(p, true), vy: d.getFloat64(p + 8, true), omega: d.getFloat64(p + 16, true) }),
  },
  SwerveModuleState: { size: 16, read: (d, p) => ({ speed: d.getFloat64(p, true), angle: d.getFloat64(p + 8, true) }) },
  // Pose3d: translation (x, y, z) then rotation as a quaternion (w, x, y, z)
  Pose3d: {
    size: 56,
    read: (d, p) => ({
      x: d.getFloat64(p, true), y: d.getFloat64(p + 8, true), z: d.getFloat64(p + 16, true),
      qw: d.getFloat64(p + 24, true), qx: d.getFloat64(p + 32, true), qy: d.getFloat64(p + 40, true), qz: d.getFloat64(p + 48, true),
    }),
  },
}

function decodeValue(log: WpilogFile, type: string, pos: number, size: number): unknown {
  const view = log.view
  const bytes = log.bytes
  switch (type) {
    case 'double': return size === 8 ? view.getFloat64(pos, true) : undefined
    case 'float': return size === 4 ? view.getFloat32(pos, true) : undefined
    case 'int64': return size === 8 ? Number(view.getBigInt64(pos, true)) : undefined
    case 'boolean': return size >= 1 ? bytes[pos] !== 0 : undefined
    case 'string':
    case 'json':
      return utf8.decode(bytes.subarray(pos, pos + size))
    case 'double[]': return Array.from({ length: size >> 3 }, (_, i) => view.getFloat64(pos + i * 8, true))
    case 'float[]': return Array.from({ length: size >> 2 }, (_, i) => view.getFloat32(pos + i * 4, true))
    case 'int64[]': return Array.from({ length: size >> 3 }, (_, i) => Number(view.getBigInt64(pos + i * 8, true)))
    case 'boolean[]': return Array.from(bytes.subarray(pos, pos + size), (b) => b !== 0)
    case 'string[]': return decodeStringArray(view, bytes, pos, size)
  }
  const struct = /^struct:(\w+)(\[\])?$/.exec(type)
  if (struct && STRUCTS[struct[1]]) {
    const s = STRUCTS[struct[1]]
    if (!struct[2]) return size === s.size ? s.read(view, pos) : undefined
    if (size % s.size !== 0) return undefined
    return Array.from({ length: size / s.size }, (_, i) => s.read(view, pos + i * s.size))
  }
  return bytes.slice(pos, pos + size) // raw, proto and unknown structs: the bytes, undecoded
}

function decodeStringArray(view: DataView, bytes: Uint8Array, pos: number, size: number): string[] | undefined {
  if (size < 4) return undefined
  const end = pos + size
  const count = view.getUint32(pos, true)
  const out: string[] = []
  let q = pos + 4
  for (let i = 0; i < count; i++) {
    if (q + 4 > end) return undefined
    const len = view.getUint32(q, true)
    if (q + 4 + len > end) return undefined
    out.push(utf8.decode(bytes.subarray(q + 4, q + 4 + len)))
    q += 4 + len
  }
  return out
}
