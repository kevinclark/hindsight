/**
 * Small text fixtures cut from real logs, and a writer that turns them back into .wpilog / .dslog bytes, so the
 * real readers and rules run on them. Fixtures live in fixtures/*.json (made by scripts/extract-fixtures.ts).
 */

export type FixtureValue = number | boolean | string | string[] | { x: number; y: number; rot: number }

export interface FixtureEntry {
  name: string
  type: string
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
  const b = new ArrayBuffer(24)
  const d = new DataView(b)
  switch (type) {
    case 'double': case 'struct:Rotation2d': d.setFloat64(0, v as number, true); return new Uint8Array(b, 0, 8)
    case 'float': d.setFloat32(0, v as number, true); return new Uint8Array(b, 0, 4)
    case 'int64': d.setBigInt64(0, BigInt(Math.round(v as number)), true); return new Uint8Array(b, 0, 8)
    case 'boolean': return new Uint8Array([v ? 1 : 0])
    case 'string': case 'json': return enc.encode(v as string)
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

/** One record with 4-byte id, 4-byte size and 8-byte timestamp fields. */
function record(id: number, timeSeconds: number, payload: Uint8Array): Uint8Array {
  const h = new DataView(new ArrayBuffer(17))
  h.setUint8(0, 0x3 | (0x3 << 2) | (0x7 << 4))
  h.setUint32(1, id, true)
  h.setUint32(5, payload.length, true)
  h.setBigUint64(9, BigInt(Math.round(timeSeconds * 1e6)), true)
  return concat([new Uint8Array(h.buffer), payload])
}

export function writeWpilog(entries: FixtureEntry[]): Uint8Array {
  const header = concat([enc.encode('WPILOG'), new Uint8Array([0x00, 0x01]), u32(0)])
  const parts: Uint8Array[] = [header]
  const t0 = Math.min(...entries.flatMap((e) => e.records.map((r) => r[0])))
  entries.forEach((e, i) => {
    const start = concat([new Uint8Array([0]), u32(i + 1), lenString(e.name), lenString(e.type), lenString('')])
    parts.push(record(0, t0, start))
  })
  const all = entries.flatMap((e, i) => e.records.map((r) => ({ id: i + 1, t: r[0], payload: encodeValue(e.type, r[1]) })))
  all.sort((a, b) => a.t - b.t)
  for (const r of all) parts.push(record(r.id, r.t, r.payload))
  return concat(parts)
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
    out.setUint8(p + 5, 0xff) // all status bits false (active low)
  }
  return new Uint8Array(out.buffer)
}
