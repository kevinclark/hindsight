/**
 * Two robot snapshots, compared: what changed on the robot between them (before and after a limits-wizard run, a
 * repair, a deploy). Compares what is set or latched, never live readings: the device list, firmware, serial
 * numbers, every config value, and sticky faults. Voltages, temperatures and the bus load change on every read.
 */
import { busLabel, parseBool, type Device, type Snapshot } from './snapshot.ts'

export type ChangeKind = 'device added' | 'device removed' | 'firmware' | 'serial' | 'Pro' | 'config' | 'sticky fault'

export interface Change { device: string; kind: ChangeKind; field: string; before: string; after: string }

const label = (d: Device) => `${d.model} ${d.id} (${busLabel(d.bus)})`
const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v))

function stickyValues(d: Device): Map<string, string> {
  const out = new Map<string, string>()
  if (!d.signals || !d.selfTest) return out
  for (const s of d.signals) {
    if (!s.name.startsWith('StickyFault_')) continue
    const row = d.selfTest[String(s.id)] ?? d.selfTest[s.name]
    const v = row === undefined ? null : parseBool(row.Value)
    out.set(s.name.slice('StickyFault_'.length), v === null ? 'unreadable' : v ? 'set' : 'clear')
  }
  return out
}

function compareMaps(a: Map<string, string>, b: Map<string, string>, push: (field: string, before: string, after: string) => void) {
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key) ?? '—'
    const y = b.get(key) ?? '—'
    if (x !== y) push(key, x, y)
  }
}

/** Order the two by when they were taken and list every change from the earlier to the later. */
export function diffSnapshots(one: Snapshot, two: Snapshot): { earlier: Snapshot; later: Snapshot; changes: Change[] } {
  const [earlier, later] = Date.parse(one.takenAt) <= Date.parse(two.takenAt) ? [one, two] : [two, one]
  const changes: Change[] = []
  const before = new Map(earlier.devices.map((d) => [d.key, d]))
  const after = new Map(later.devices.map((d) => [d.key, d]))
  for (const [key, d] of before) if (!after.has(key)) changes.push({ device: label(d), kind: 'device removed', field: '', before: d.serial, after: '—' })
  for (const [key, b] of after) {
    const a = before.get(key)
    if (!a) { changes.push({ device: label(b), kind: 'device added', field: '', before: '—', after: b.serial }); continue }
    const push = (kind: ChangeKind) => (field: string, x: string, y: string) => changes.push({ device: label(b), kind, field, before: x, after: y })
    if (a.firmware !== b.firmware) push('firmware')('', a.firmware, b.firmware)
    if ([...a.serials].sort().join(',') !== [...b.serials].sort().join(',')) push('serial')('a different device answers to this ID (replaced?)', a.serials.join(', '), b.serials.join(', '))
    if (a.pro !== b.pro) push('Pro')('', String(a.pro), String(b.pro))
    // Configs only when both were read: a config missing from one side is a collection gap, not a change.
    if (a.configs && b.configs) {
      // Keyed by SignalName (unique and stable); shown with the group and display name.
      const values = (d: Device) => new Map(d.configs!.map((c) => [`${c.group} › ${c.name || c.signalName} (${c.signalName})`, show(c.value)]))
      compareMaps(values(a), values(b), push('config'))
    }
    if (a.selfTest && b.selfTest) compareMaps(stickyValues(a), stickyValues(b), push('sticky fault'))
  }
  return { earlier, later, changes }
}
