import { writeRecords } from '../../src/readers/wpilog-writer.ts'

/**
 * Small text fixtures cut from real logs, and a writer that turns them back into .wpilog / .dslog bytes, so the
 * real readers and rules run on them. Fixtures live in fixtures/*.json (made by scripts/extract-fixtures.ts).
 */

/** A Uint8Array is written as is: the payload of a struct record (see packStruct). */
export type FixtureValue = number | boolean | string | string[] | { x: number; y: number; rot: number } | Uint8Array

export interface FixtureEntry {
  name: string
  type: string
  /** The entry's metadata string (DataLogManager's NT capture puts NT properties here). */
  metadata?: string
  /** [time in seconds, value] */
  records: [number, FixtureValue][]
}

export interface FixtureDslog {
  name: string
  startEpochSeconds: number
  /** Number of 20 ms records. */
  count: number
  /** Records from this index on say "no robot" (voltage 0xFFFF). */
  noRobotFrom: number
  /** Records before this index also say "no robot" (DS opened before the robot connected). */
  robotFrom: number
  /** Records [from, to) with the brownout flag set. */
  brownouts?: [number, number][]
}

export interface Fixture {
  source: string
  note: string
  entries: FixtureEntry[]
  dslog?: FixtureDslog
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

function encodeValue(type: string, v: FixtureValue): Uint8Array {
  if (v instanceof Uint8Array) return v
  const b = new ArrayBuffer(24)
  const d = new DataView(b)
  switch (type) {
    case 'double': case 'struct:Rotation2d': d.setFloat64(0, v as number, true); return new Uint8Array(b, 0, 8)
    case 'float': d.setFloat32(0, v as number, true); return new Uint8Array(b, 0, 4)
    case 'int64': d.setBigInt64(0, BigInt(Math.round(v as number)), true); return new Uint8Array(b, 0, 8)
    case 'boolean': return new Uint8Array([v ? 1 : 0])
    case 'string': case 'json': case 'structschema': return enc.encode(v as string)
    case 'string[]': return concat([u32((v as string[]).length), ...(v as string[]).map(lenString)])
    case 'double[]': {
      const arr = v as unknown as number[]
      const out = new DataView(new ArrayBuffer(arr.length * 8))
      arr.forEach((x, i) => out.setFloat64(i * 8, x, true))
      return new Uint8Array(out.buffer)
    }
    case 'struct:Pose2d': case 'struct:ChassisSpeeds': {
      const p = v as { x: number; y: number; rot: number }
      const vals = type === 'struct:Pose2d' ? [p.x, p.y, p.rot] : [(p as never as { vx: number }).vx, (p as never as { vy: number }).vy, (p as never as { omega: number }).omega]
      vals.forEach((x, i) => d.setFloat64(i * 8, x, true))
      return new Uint8Array(b, 0, 24)
    }
  }
  throw new Error(`fixture writer: unsupported type ${type}`)
}

/** A struct record's payload: doubles, little-endian, in schema order. */
export function packDoubles(values: number[]): Uint8Array {
  const d = new DataView(new ArrayBuffer(values.length * 8))
  values.forEach((x, i) => d.setFloat64(i * 8, x, true))
  return new Uint8Array(d.buffer)
}

/**
 * The fixture as a .wpilog, through the same writer Foresight uses (src/readers/wpilog-writer.ts); only the value
 * encoding is the fixture's own. Each entry's records are put in time order (stable, so equal times keep their order).
 */
export function writeWpilog(entries: FixtureEntry[]): Uint8Array {
  return writeRecords(entries.map((e) => {
    const order = e.records.map((_, i) => i).sort((a, b) => e.records[a][0] - e.records[b][0] || a - b)
    return { name: e.name, type: e.type, metadata: e.metadata, t: order.map((i) => e.records[i][0]), payload: order.map((i) => encodeValue(e.type, e.records[i][1])) }
  }))
}

export function writeDslog(ds: FixtureDslog): Uint8Array {
  const out = new DataView(new ArrayBuffer(20 + ds.count * 14))
  out.setInt32(0, 4, false)
  const whole = Math.floor(ds.startEpochSeconds)
  out.setBigInt64(4, BigInt(whole + 2082844800), false)
  out.setBigUint64(12, BigInt(Math.round((ds.startEpochSeconds - whole) * 2 ** 32)) << 32n, false)
  for (let i = 0; i < ds.count; i++) {
    const p = 20 + i * 14
    out.setUint8(p, 12) // 6 ms trip time
    const robot = i >= ds.robotFrom && i < ds.noRobotFrom
    out.setUint16(p + 2, robot ? Math.round(12.5 * 256) : 0xffff, false)
    const brownout = ds.brownouts?.some(([from, to]) => i >= from && i < to) ?? false
    out.setUint8(p + 5, brownout ? 0x7f : 0xff) // status bits, active low: all false, or bit 7 (brownout) true
  }
  return new Uint8Array(out.buffer)
}
