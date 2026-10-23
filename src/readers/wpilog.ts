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
 *
 * Two kinds of key name a log doesn't list as entries, so profiles can point at them like any other signal:
 *   - a field of a struct entry: the entry name, "/", then the field ("NT:/Telemetry/hood/motor/" + "supplyCurrent";
 *     nested fields join with "/"). The layout comes from the log's own /.schema/struct:<Type> entry, so any team's
 *     struct (a TalonFX status struct, a gyro struct) decodes without code here. This is how AdvantageScope names them.
 *   - one bit of an integer entry: the entry name, ":bit", then the bit number ("NT:/FMSInfo/FMSControlData:bit4").
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
  /** First and last data record time, seconds (0 and 0 for a log with no records). */
  firstTime: number
  lastTime: number
  /** Key names resolved to an entry (and a struct field or bit), filled as keys are asked for. */
  resolved: Map<string, Resolved | null>
  /** Struct layouts by type name, from the log's /.schema/struct:* entries (read on first use). */
  structs: Map<string, StructLayout | null> | null
}

/** A key resolved to the entry that holds it, and the part of each record to read. */
interface Resolved {
  entry: WpilogEntry
  /** A numeric field inside a struct record. */
  field?: { offset: number; field: StructField; recordSize: number }
  /** One bit of an integer entry. */
  bit?: number
  /** One element of a numeric array entry. */
  index?: number
}

/** One field of a struct, laid out as WPILib packs it: no padding, bit-fields packed into their integer type. */
export interface StructField {
  name: string
  /** bool, char, int8..int64, uint8..uint64, float, double, or another struct's name. */
  type: string
  offset: number
  size: number
  /** For a nested struct field. */
  struct?: StructLayout
  /** For an array field ("double x[4]"). */
  arrayLength?: number
  /** For a bit-field ("bool flag:1"): where its bits sit in the integer at `offset`. */
  bitShift?: number
  bitWidth?: number
}

export interface StructLayout { name: string; size: number; fields: StructField[] }

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
  // Timestamps are signed: a NetworkTables client whose clock wasn't synced yet can log a time before the log
  // started, which reads as a huge unsigned number.
  const timestampUs = tsLen === 8 && bytes[p + 7] & 0x80
    ? Number(new DataView(bytes.buffer, bytes.byteOffset + p, 8).getBigInt64(0, true))
    : readUintLE(bytes, p, tsLen)
  p += tsLen
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
  let firstUs = Infinity
  let lastUs = -Infinity
  let pos = firstRecord
  while (pos < bytes.length) {
    const h = readHeader(bytes, pos)
    if (!h) { warnings.push(`The last record is cut off at byte ${pos} of ${bytes.length}; normal when the robot is switched off while logging`); break }
    if (h.entryId === 0) {
      readControlRecord(bytes, view, h, entries, nameById, warnings)
    } else {
      if (h.timestampUs >= 0 && h.timestampUs < firstUs) firstUs = h.timestampUs
      if (h.timestampUs > lastUs) lastUs = h.timestampUs
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

  const [firstTime, lastTime] = Number.isFinite(firstUs) ? [firstUs / 1e6, lastUs / 1e6] : [0, 0]
  return { bytes, view, entries, recordCount, entryStart, recordPos, warnings, firstTime, lastTime, resolved: new Map(), structs: null }
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

/** True when the log has this key (an entry, a struct field or a bit of one) with at least one record. */
export function hasEntry(log: WpilogFile, name: string): boolean {
  const e = resolveKey(log, name)?.entry
  return !!e && log.entryStart[e.id + 1] > log.entryStart[e.id]
}

/**
 * Find the entry behind a key: the entry itself, a field of a struct entry ("<entry>/<field>"), a bit of an
 * integer entry ("<entry>:bit<n>"), or an element of a numeric array entry ("<entry>[n]", from 0). Null when the log
 * has none of these.
 */
/** The entry a key reads from: itself, or the entry behind a bit ("<entry>:bit4"), a struct field ("<entry>/x") or an element ("<entry>[0]"). */
export function entryNameFor(log: WpilogFile, name: string): string | null {
  return resolveKey(log, name)?.entry.name ?? null
}

function resolveKey(log: WpilogFile, name: string): Resolved | null {
  if (log.resolved.has(name)) return log.resolved.get(name)!
  let found: Resolved | null = null
  const entry = log.entries.get(name)
  if (entry) found = { entry }
  const bit = /^(.*):bit(\d+)$/.exec(name)
  if (!found && bit && log.entries.get(bit[1])?.type === 'int64') found = { entry: log.entries.get(bit[1])!, bit: Number(bit[2]) }
  const element = /^(.*)\[(\d+)\]$/.exec(name)
  const array = element ? log.entries.get(element[1]) : undefined
  if (!found && array && ARRAY_ELEMENT_SIZES[array.type]) found = { entry: array, index: Number(element![2]) }
  // A struct field: try each "/" from the right as the end of the entry name (with and without the slash, since
  // some loggers name struct entries with a trailing "/").
  for (let i = name.lastIndexOf('/'); !found && i > 0; i = name.lastIndexOf('/', i - 1)) {
    for (const entryName of [name.slice(0, i + 1), name.slice(0, i)]) {
      const e = log.entries.get(entryName)
      const type = e && /^struct:(\w+)$/.exec(e.type)?.[1]
      const layout = type ? structLayout(log, type) : null
      const field = layout ? fieldAt(layout, name.slice(i + 1).split('/')) : null
      if (e && layout && field) { found = { entry: e, field: { ...field, recordSize: layout.size } }; break }
    }
  }
  log.resolved.set(name, found)
  return found
}

/** A numeric field by path ("translation/x"), with its offset from the start of the record. */
function fieldAt(layout: StructLayout, path: string[]): { offset: number; field: StructField } | null {
  let offset = 0
  let current: StructLayout = layout
  for (let k = 0; k < path.length; k++) {
    const f = current.fields.find((x) => x.name === path[k])
    if (!f || f.arrayLength !== undefined) return null
    offset += f.offset
    if (k === path.length - 1) return f.struct ? null : { offset, field: f }
    if (!f.struct) return null
    current = f.struct
  }
  return null
}

const SCALAR_SIZES: Record<string, number> = {
  bool: 1, char: 1, int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, int64: 8, uint64: 8,
  float: 4, float32: 4, double: 8, float64: 8,
}

/** The layout of a struct type, parsed from the log's schema entry (null if the log has no schema for it). */
export function structLayout(log: WpilogFile, type: string): StructLayout | null {
  if (!log.structs) {
    // The schema's last record wins (a schema is normally published once).
    const texts = new Map<string, string>()
    for (const e of log.entries.values()) {
      const m = /\.schema\/struct:(\w+)$/.exec(e.name)
      const from = log.entryStart[e.id], to = log.entryStart[e.id + 1]
      if (e.type !== 'structschema' || !m || to <= from) continue
      const h = readHeader(log.bytes, log.recordPos[to - 1])!
      texts.set(m[1], utf8.decode(log.bytes.subarray(h.payloadPos, h.payloadPos + h.size)))
    }
    log.structs = new Map([...texts.keys()].map((name) => [name, parseStruct(name, texts, new Set())]))
  }
  return log.structs.get(type) ?? null
}

/**
 * Parse a WPILib struct schema ("double x; double y; Rotation2d rotation; bool flag:1; enum {a=1} int8 mode") into
 * a layout. Null when it names a struct the log has no schema for, or can't be read.
 */
export function parseStruct(name: string, texts: Map<string, string>, parents: Set<string>): StructLayout | null {
  const text = texts.get(name)
  if (text === undefined || parents.has(name)) return null
  const fields: StructField[] = []
  let offset = 0
  // The integer a run of bit-fields is being packed into: its offset, size in bytes and the next free bit.
  let bits: { offset: number; size: number; used: number } | null = null
  for (const raw of text.split(';')) {
    const decl = raw.replace(/^\s*enum\s*\{[^}]*\}\s*/, '').trim()
    if (!decl) continue
    const m = /^(\w+)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*(?::\s*(\d+))?$/.exec(decl)
    if (!m) return null
    const [, type, fieldName, arrayLen, bitWidth] = m
    if (bitWidth !== undefined) {
      const size = type === 'bool' ? 1 : SCALAR_SIZES[type]
      if (!size || type.startsWith('float') || type === 'double') return null
      const width = Number(bitWidth)
      // A bool bit-field packs into the run before it whatever that run's integer type, if it fits (WPILib struct
      // spec, "Bit-Field Data Layout"); other bit-fields start a new run when the integer size changes.
      const joins = bits && bits.used + width <= bits.size * 8 && (type === 'bool' || bits.size === size)
      if (!joins) {
        bits = { offset, size, used: 0 }
        offset += size
      }
      fields.push({ name: fieldName, type, offset: bits!.offset, size: bits!.size, bitShift: bits!.used, bitWidth: width })
      bits!.used += width
      continue
    }
    bits = null
    const count = arrayLen === undefined ? 1 : Number(arrayLen)
    let size = SCALAR_SIZES[type]
    let struct: StructLayout | undefined
    if (size === undefined) {
      const inner = parseStruct(type, texts, new Set([...parents, name]))
      if (!inner) return null
      struct = inner
      size = inner.size
    }
    fields.push({ name: fieldName, type, offset, size, ...(struct ? { struct } : {}), ...(arrayLen !== undefined ? { arrayLength: count } : {}) })
    offset += size * count
  }
  return { name, size: offset, fields }
}

/** Read one scalar struct field (bit-fields included) as a number. */
function readField(view: DataView, pos: number, f: StructField): number {
  let v: number
  switch (f.type) {
    case 'bool': case 'uint8': case 'char': v = view.getUint8(pos); break
    case 'int8': v = view.getInt8(pos); break
    case 'int16': v = view.getInt16(pos, true); break
    case 'uint16': v = view.getUint16(pos, true); break
    case 'int32': v = view.getInt32(pos, true); break
    case 'uint32': v = view.getUint32(pos, true); break
    case 'int64': v = Number(view.getBigInt64(pos, true)); break
    case 'uint64': v = Number(view.getBigUint64(pos, true)); break
    case 'float': case 'float32': return view.getFloat32(pos, true)
    case 'double': case 'float64': return view.getFloat64(pos, true)
    default: return NaN
  }
  if (f.bitWidth === undefined) return f.type === 'bool' ? (v !== 0 ? 1 : 0) : v
  const unsigned = f.size === 8 ? Number(view.getBigUint64(pos, true)) : f.size === 4 ? view.getUint32(pos, true) : f.size === 2 ? view.getUint16(pos, true) : view.getUint8(pos)
  return Math.floor(unsigned / 2 ** f.bitShift!) % 2 ** f.bitWidth
}

/** A whole struct record as a plain object, by its schema (arrays of fields become arrays). */
function readStruct(view: DataView, pos: number, layout: StructLayout): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of layout.fields) {
    const one = (p: number) => (f.struct ? readStruct(view, p, f.struct) : f.type === 'bool' && f.bitWidth === undefined ? view.getUint8(p) !== 0 : readField(view, p, f))
    out[f.name] = f.arrayLength === undefined ? one(pos + f.offset) : Array.from({ length: f.arrayLength }, (_, i) => one(pos + f.offset + i * f.size))
  }
  return out
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
  const found = resolveKey(log, name)
  if (!found) return null
  const entry = found.entry
  const decode = found.field ? fieldDecoder(log, found.field) : found.bit !== undefined ? bitDecoder(log, found.bit) : found.index !== undefined ? elementDecoder(log, entry.type, found.index) : numberDecoder(log, entry.type)
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
  return sortedByTime({ name, t: t.subarray(0, i), v: v.subarray(0, i) })
}

/**
 * Records are in file order, which is time order except for the odd record a NetworkTables client stamped before
 * its clock synced. Hold-last lookups need time order, so sort when that happens.
 */
function sortedByTime<S extends { name: string; t: Float64Array; v: Float64Array | unknown[] }>(s: S): S {
  let sorted = true
  for (let k = 1; k < s.t.length && sorted; k++) if (s.t[k] < s.t[k - 1]) sorted = false
  if (sorted) return s
  const order = Array.from(s.t.keys()).sort((a, b) => s.t[a] - s.t[b] || a - b)
  const t = Float64Array.from(order, (k) => s.t[k])
  const v = s.v instanceof Float64Array ? Float64Array.from(order, (k) => (s.v as Float64Array)[k]) : order.map((k) => (s.v as unknown[])[k])
  return { ...s, t, v }
}

function fieldDecoder(log: WpilogFile, f: NonNullable<Resolved['field']>): (pos: number, size: number) => number | null {
  return (pos, size) => (size === f.recordSize ? readField(log.view, pos + f.offset, f.field) : null)
}

function bitDecoder(log: WpilogFile, bit: number): (pos: number, size: number) => number | null {
  return (pos, size) => (size === 8 ? Number((log.view.getBigUint64(pos, true) >> BigInt(bit)) & 1n) : null)
}

const ARRAY_ELEMENT_SIZES: Record<string, number> = { 'double[]': 8, 'float[]': 4, 'int64[]': 8, 'boolean[]': 1 }

/** Element `index` of each record of a numeric array; null for a record too short to have it. */
function elementDecoder(log: WpilogFile, type: string, index: number): (pos: number, size: number) => number | null {
  const n = ARRAY_ELEMENT_SIZES[type]
  const read = numberDecoder(log, type.slice(0, -2))!
  return (pos, size) => (size >= (index + 1) * n ? read(pos + index * n, n) : null)
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
  const found = resolveKey(log, name)
  if (!found) return null
  if (found.field || found.bit !== undefined || found.index !== undefined) {
    const n = readNumbers(log, name)!
    return { name, t: n.t, v: Array.from(n.v) as T[] }
  }
  const entry = found.entry
  const t: number[] = []
  const v: T[] = []
  forEachRecord(log, entry, (time, pos, size) => {
    const value = decodeValue(log, entry.type, pos, size)
    if (value === undefined) return
    t.push(time)
    v.push(value as T)
  })
  return sortedByTime({ name, t: Float64Array.from(t), v })
}

/**
 * One entry's records as raw payload bytes (copies), in file order: for replaying a log record by record (Foresight's
 * backtest and its test NT4 server). Null when the log has no such entry.
 */
export function readRaw(log: WpilogFile, name: string): { entry: WpilogEntry; t: number[]; payload: Uint8Array[] } | null {
  const entry = log.entries.get(name)
  if (!entry) return null
  const t: number[] = []
  const payload: Uint8Array[] = []
  forEachRecord(log, entry, (time, pos, size) => { t.push(time); payload.push(log.bytes.slice(pos, pos + size)) })
  return { entry, t, payload }
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
    case 'structschema':
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
  // Any other struct the log carries a schema for: a plain object of its fields.
  const layout = struct ? structLayout(log, struct[1]) : null
  if (struct && layout && layout.size > 0) {
    if (!struct[2]) return size === layout.size ? readStruct(view, pos, layout) : undefined
    if (size % layout.size !== 0) return undefined
    return Array.from({ length: size / layout.size }, (_, i) => readStruct(view, pos + i * layout.size, layout))
  }
  return bytes.slice(pos, pos + size) // raw, proto and structs with no schema: the bytes, undecoded
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
