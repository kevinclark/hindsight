/**
 * A .hoot that no robot log took, as a small .wpilog Match review can open: what the .hoot recorded about the robot
 * (its enable, its mode, the sum of the Talons' supply current), under the names the "Phoenix hoot" log format reads
 * (src/profiles/formats.ts). Not a conversion of the .hoot: the Devices tab still reads the .hoot itself. Pure; the main
 * process hands in the reading (electron/hoot-ipc.ts `hub:hootLog`).
 */
import { encodePayload, writeRecords, type RecordEntry } from '../readers/wpilog-writer.ts'
import type { HootReading } from './types.ts'

type Change<V> = { t: number; v: V }

/** Records for `changes`, with the first value held from `start` and the last repeated at `end`, so the log spans the whole .hoot. */
function spanning<V>(changes: Change<V>[], start: number, end: number, initial: V): Change<V>[] {
  const out = changes.length ? [...changes] : [{ t: start, v: initial }]
  if (out[0].t > start) out.unshift({ t: start, v: out[0].v })
  if (out[out.length - 1].t < end) out.push({ t: end, v: out[out.length - 1].v })
  return out
}

function entry<V extends boolean | number>(name: string, type: 'boolean' | 'double', records: Change<V>[]): RecordEntry {
  return { name, type, t: records.map((r) => r.t), payload: records.map((r) => encodePayload(type, r.v)!) }
}

export function hootWpilog(r: HootReading): Uint8Array {
  const entries: RecordEntry[] = [
    entry('RobotEnable', 'boolean', spanning(r.enable.map((e) => ({ t: e.t, v: e.on })), r.start, r.end, false)),
    entry('Phoenix6/Autonomous', 'boolean', spanning(r.mode.map((m) => ({ t: m.t, v: m.v === 'Autonomous' })), r.start, r.end, false)),
  ]
  if (r.fms.length) entries.push(entry('DS:IsFMSAttached', 'boolean', spanning(r.fms.map((f) => ({ t: f.t, v: f.on })), r.start, r.end, false)))
  const total = r.totalAmps.t.map((t, i): Change<number> => ({ t, v: r.totalAmps.a[i] }))
  entries.push(entry('Phoenix6/TotalSupplyCurrent', 'double', spanning(total, r.start, r.end, 0)))
  return writeRecords(entries)
}
