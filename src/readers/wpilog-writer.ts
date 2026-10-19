/**
 * Write a .wpilog in memory from records whose payloads are already encoded, and encode plain values into payloads.
 *
 * Foresight keeps the robot's live NetworkTables values as records and, every second, writes the ones since start-up
 * settled into a small .wpilog that the ordinary reader, match model and rules read unchanged. The backtest does the
 * same from a match log, so the live check and the backtest run the same code.
 *
 * Format spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.adoc
 */

export interface RecordEntry {
  name: string
  type: string
  metadata?: string
  /** Record times, seconds, ascending. */
  t: number[]
  payload: Uint8Array[]
}

const enc = new TextEncoder()

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function lenString(s: string): Uint8Array {
  const bytes = enc.encode(s)
  return concat([u32(bytes.length), bytes])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Record header: 4-byte id, 4-byte size, 8-byte signed timestamp (µs). */
function header(id: number, timeSeconds: number, size: number): Uint8Array {
  const h = new DataView(new ArrayBuffer(17))
  h.setUint8(0, 0x3 | (0x3 << 2) | (0x7 << 4))
  h.setUint32(1, id, true)
  h.setUint32(5, size, true)
  h.setBigInt64(9, BigInt(Math.round(timeSeconds * 1e6)), true)
  return new Uint8Array(h.buffer)
}

/** One .wpilog holding these entries, each entry's records in time order. Entries with no records are still announced. */
export function writeRecords(entries: RecordEntry[]): Uint8Array {
  const parts: Uint8Array[] = [concat([enc.encode('WPILOG'), new Uint8Array([0x00, 0x01]), u32(0)])]
  let t0 = Infinity
  for (const e of entries) if (e.t.length && e.t[0] < t0) t0 = e.t[0]
  if (!Number.isFinite(t0)) t0 = 0
  entries.forEach((e, i) => {
    const start = concat([new Uint8Array([0]), u32(i + 1), lenString(e.name), lenString(e.type), lenString(e.metadata ?? '')])
    parts.push(header(0, t0, start.length), start)
  })
  // Entry by entry: the spec doesn't require records in global time order, and the reader indexes each entry's records
  // separately (it only needs each entry in order), so there's no merge to pay for every second.
  entries.forEach((e, i) => {
    for (let k = 0; k < e.t.length; k++) parts.push(header(i + 1, e.t[k], e.payload[k].length), e.payload[k])
  })
  return concat(parts)
}

/**
 * A plain value (as NetworkTables delivers it) as a .wpilog payload for an entry of this type. Struct and raw values
 * arrive as bytes and are written as they are. Null when the value doesn't fit the type.
 */
export function encodePayload(type: string, value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'bigint' ? Number(x) : NaN)
  const fixed = (size: number, write: (d: DataView) => void) => { const d = new DataView(new ArrayBuffer(size)); write(d); return new Uint8Array(d.buffer) }
  switch (type) {
    case 'double': return Number.isNaN(num(value)) ? null : fixed(8, (d) => d.setFloat64(0, num(value), true))
    case 'float': return Number.isNaN(num(value)) ? null : fixed(4, (d) => d.setFloat32(0, num(value), true))
    case 'int64': return Number.isNaN(num(value)) ? null : fixed(8, (d) => d.setBigInt64(0, BigInt(Math.round(num(value))), true))
    case 'boolean': return typeof value === 'boolean' ? new Uint8Array([value ? 1 : 0]) : null
    case 'string': case 'json': return typeof value === 'string' ? enc.encode(value) : null
  }
  if (!Array.isArray(value)) return null
  switch (type) {
    case 'boolean[]': return new Uint8Array(value.map((b) => (b ? 1 : 0)))
    case 'double[]': return fixed(8 * value.length, (d) => value.forEach((x, i) => d.setFloat64(8 * i, num(x), true)))
    case 'float[]': return fixed(4 * value.length, (d) => value.forEach((x, i) => d.setFloat32(4 * i, num(x), true)))
    case 'int64[]': return fixed(8 * value.length, (d) => value.forEach((x, i) => d.setBigInt64(8 * i, BigInt(Math.round(num(x))), true)))
    case 'string[]': return concat([u32(value.length), ...value.map((s) => lenString(String(s)))])
  }
  return null
}
