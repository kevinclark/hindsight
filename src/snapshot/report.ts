/**
 * What a robot snapshot says against the robot profile: which devices are on the bus, which motors run the current
 * limits the code sets, and which devices latched a sticky fault. All of it from the snapshot alone, no log needed.
 */
import type { CurrentLimits, MotorGroup, RobotProfile } from '../profiles/types.ts'
import { busLabel, configOf, parseBool, parseNumber, type Device, type Snapshot } from './snapshot.ts'

/** The part of a robot profile the snapshot needs. A profile file with just these fields works too. */
export type SnapshotProfile = Pick<RobotProfile, 'name' | 'motorGroups'>

// ---------------------------------------------------------------------------------------------------------------
// Profile choice and inventory

/** The profile with the most of its motor CAN IDs on the bus, or null when none has any. */
export function chooseProfile<P extends SnapshotProfile>(snapshot: Snapshot, profiles: P[]): P | null {
  const ids = new Set(snapshot.devices.filter((d) => d.isMotor).map((d) => d.id))
  let best: { profile: P; found: number } | null = null
  for (const profile of profiles) {
    const found = profile.motorGroups.flatMap((g) => g.motors).filter((m) => m.canId !== undefined && ids.has(m.canId)).length
    if (found > 0 && (!best || found > best.found)) best = { profile, found }
  }
  return best?.profile ?? null
}

export type InventoryStatus = 'found' | 'missing' | 'ambiguous' | 'no-can-id' | 'extra' | 'other'

export interface InventoryRow {
  status: InventoryStatus
  /** The profile's motor, when the row is about one. */
  motor?: { group: string; name: string; canId?: number }
  /** The device(s) on the bus. */
  devices: Device[]
  note: string
}

/** The profile's motors that have a CAN ID, matched to the bus. Motors match Talon FX devices by ID, on any bus. */
function matchMotors(snapshot: Snapshot, profile: SnapshotProfile) {
  const motors = snapshot.devices.filter((d) => d.isMotor)
  return profile.motorGroups.flatMap((group) => group.motors.map((motor) => {
    const devices = motor.canId === undefined ? [] : motors.filter((d) => d.id === motor.canId)
    return { group, motor, devices }
  }))
}

export function inventory(snapshot: Snapshot, profile: SnapshotProfile | null): InventoryRow[] {
  const rows: InventoryRow[] = []
  const claimed = new Set<string>()
  const unnumbered = profile ? profile.motorGroups.flatMap((g) => g.motors).filter((m) => m.canId === undefined).length : 0
  for (const { group, motor, devices } of profile ? matchMotors(snapshot, profile) : []) {
    const about = { group: group.name, name: motor.name, canId: motor.canId }
    devices.forEach((d) => claimed.add(d.key))
    if (motor.canId === undefined) rows.push({ status: 'no-can-id', motor: about, devices, note: 'The profile has no CAN ID for this motor, so it can\'t be found on the bus.' })
    else if (devices.length === 0) rows.push({ status: 'missing', motor: about, devices, note: `No Talon FX answers to CAN ID ${motor.canId}: unplugged, unpowered, on another ID, or its CAN wiring is broken.` })
    else if (devices.length > 1) {
      rows.push({ status: 'ambiguous', motor: about, devices, note: `CAN ID ${motor.canId} is on more than one bus (${devices.map((d) => busLabel(d.bus)).join(', ')}). That is allowed, but the profile doesn't say which bus this motor is on, so its limits can't be checked.` })
    } else if (devices[0].count > 1) {
      rows.push({ status: 'ambiguous', motor: about, devices, note: `CAN ID ${motor.canId} is used by ${devices[0].count} devices on the ${busLabel(devices[0].bus)} (serials ${devices[0].serials.join(', ')}). Two devices of one kind can't share an ID on one bus: give each its own in Phoenix Tuner X.` })
    } else rows.push({ status: 'found', motor: about, devices, note: '' })
  }
  for (const d of snapshot.devices) {
    if (claimed.has(d.key)) continue
    if (d.count > 1) rows.push({ status: 'ambiguous', devices: [d], note: `Duplicate ID: ${d.count} devices answer as ${d.model} ${d.id} on the ${busLabel(d.bus)} (serials ${d.serials.join(', ')}). Only one of them was read.` })
    else if (d.isMotor) rows.push({ status: 'extra', devices: [d], note: !profile ? 'No profile chosen.' : unnumbered ? `Not matched to the profile: ${unnumbered} of its motors have no CAN ID, so this may be one of them.` : 'A motor controller the profile doesn\'t list.' })
    else rows.push({ status: 'other', devices: [d], note: d.skipped ? `Not read: ${d.skipped}.` : '' })
  }
  return rows
}

// ---------------------------------------------------------------------------------------------------------------
// Current limits

interface LimitSpec { key: keyof CurrentLimits; signal: string; label: string; unit: string; kind: 'number' | 'bool' }

export const LIMIT_FIELDS: LimitSpec[] = [
  { key: 'statorA', signal: 'Config_StatorCurrentLimit', label: 'stator limit', unit: 'A', kind: 'number' },
  { key: 'statorEnabled', signal: 'Config_StatorCurrLimitEn', label: 'stator limit on', unit: '', kind: 'bool' },
  { key: 'supplyA', signal: 'Config_SupplyCurrentLimit', label: 'supply limit', unit: 'A', kind: 'number' },
  { key: 'supplyEnabled', signal: 'Config_SupplyCurrLimitEn', label: 'supply limit on', unit: '', kind: 'bool' },
  { key: 'supplyLowerA', signal: 'Config_SupplyCurrentLowerLimit', label: 'supply lower limit', unit: 'A', kind: 'number' },
  { key: 'supplyLowerSeconds', signal: 'Config_SupplyCurrentLowerTime', label: 'supply lower time', unit: 's', kind: 'number' },
]

/** Devices store limits at their own resolution (a requested 0.012 reads back 0.01171875): compare with some room. */
export const sameNumber = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, 0.01 * Math.abs(b))

export interface LimitField {
  label: string
  signal: string
  unit: string
  expected: number | boolean | null
  /** 'profile', or 'Phoenix default' when the profile leaves the field out (the code doesn't set it). */
  expectedFrom: 'profile' | 'Phoenix default'
  applied: number | boolean | null
  /** null: couldn't be compared (missing from the answer, or unreadable). */
  ok: boolean | null
}

export type MotorLimitStatus = 'ok' | 'differs' | 'unreadable' | 'not-on-bus' | 'no-can-id' | 'ambiguous' | 'no-configs'

export interface MotorLimits {
  motor: string
  canId?: number
  device?: Device
  status: MotorLimitStatus
  fields: LimitField[]
  /** The applied supply limit is switched off: as the profile says, or against it. */
  supplyOff: 'as-profile' | 'unexpected' | null
}

export interface GroupLimits {
  group: string
  where: string
  /** clean: every motor checked and matching. partly: the checked ones match, some couldn't be checked. */
  status: 'clean' | 'differs' | 'partly' | 'not-checked'
  motors: MotorLimits[]
  /** Fields on which the group's motors disagree with each other (needs no profile). */
  disagree: string[]
}

const fmt = (v: number | boolean | null, unit: string) => (v === null ? '—' : typeof v === 'boolean' ? (v ? 'on' : 'off') : `${+v.toFixed(3)}${unit ? ` ${unit}` : ''}`)
export const fieldText = (f: { applied?: number | boolean | null; expected?: number | boolean | null; unit: string }, which: 'applied' | 'expected') => fmt(f[which] ?? null, f.unit)

function readField(device: Device, spec: LimitSpec): { value: number | boolean | null; defaultValue: number | boolean | null } {
  const c = configOf(device, spec.signal)
  if (!c) return { value: null, defaultValue: null }
  const read = spec.kind === 'bool' ? parseBool : parseNumber
  return { value: read(c.value), defaultValue: read(c.defaultValue) }
}

function compare(spec: LimitSpec, expected: number | boolean | null, applied: number | boolean | null): boolean | null {
  if (expected === null || applied === null) return null
  if (spec.kind === 'bool') return expected === applied
  return sameNumber(applied as number, expected as number)
}

/** One motor's applied limits against the profile's. */
export function motorLimits(device: Device, limits: CurrentLimits): LimitField[] {
  return LIMIT_FIELDS.map((spec) => {
    const { value, defaultValue } = readField(device, spec)
    const fromProfile = limits[spec.key] as number | boolean | undefined
    const expected = fromProfile ?? defaultValue
    return { label: spec.label, signal: spec.signal, unit: spec.unit, expected, expectedFrom: fromProfile === undefined ? 'Phoenix default' : 'profile', applied: value, ok: compare(spec, expected, value) }
  })
}

function groupLimits(snapshot: Snapshot, group: MotorGroup): GroupLimits {
  const motors: MotorLimits[] = group.motors.map((motor) => {
    const base = { motor: motor.name, canId: motor.canId, fields: [] as LimitField[], supplyOff: null }
    if (motor.canId === undefined) return { ...base, status: 'no-can-id' }
    const devices = snapshot.devices.filter((d) => d.isMotor && d.id === motor.canId)
    if (devices.length === 0) return { ...base, status: 'not-on-bus' }
    if (devices.length > 1 || devices[0].count > 1) return { ...base, device: devices[0], status: 'ambiguous' }
    const device = devices[0]
    if (!device.configs) return { ...base, device, status: 'no-configs' }
    const fields = motorLimits(device, group.limits)
    const supplyOn = fields.find((f) => f.signal === 'Config_SupplyCurrLimitEn')!.applied
    const supplyOff = supplyOn === false ? (group.limits.supplyEnabled === false ? 'as-profile' : 'unexpected') : null
    // A field that couldn't be read is not a match: a group is only clean when every field was read and agrees.
    const status = fields.some((f) => f.ok === false) ? 'differs' : fields.some((f) => f.ok === null) ? 'unreadable' : 'ok'
    return { ...base, device, fields, supplyOff, status }
  })
  const checked = motors.filter((m) => m.status === 'ok' || m.status === 'differs')
  const disagree = LIMIT_FIELDS.filter((spec) => {
    const values = motors.filter((m) => m.fields.length).map((m) => m.fields.find((f) => f.signal === spec.signal)!.applied).filter((v) => v !== null)
    return values.some((v) => compare(spec, values[0], v) === false)
  }).map((s) => s.label)
  const status = motors.some((m) => m.status === 'differs') ? 'differs' : checked.length === 0 ? 'not-checked' : checked.length < motors.length ? 'partly' : 'clean'
  return { group: group.name, where: group.limits.where, status, motors, disagree }
}

export interface LimitsReport {
  groups: GroupLimits[]
  /** Talon FX not in any profile group whose supply limit is switched off. */
  supplyOffElsewhere: Device[]
}

export function limitsReport(snapshot: Snapshot, profile: SnapshotProfile | null): LimitsReport {
  const groups = profile ? profile.motorGroups.map((g) => groupLimits(snapshot, g)) : []
  const inGroups = new Set(groups.flatMap((g) => g.motors.map((m) => m.device?.key)).filter(Boolean))
  const supplyOffElsewhere = snapshot.devices.filter((d) => d.isMotor && !inGroups.has(d.key) && parseBool(configOf(d, 'Config_SupplyCurrLimitEn')?.value) === false)
  return { groups, supplyOffElsewhere }
}

// ---------------------------------------------------------------------------------------------------------------
// Sticky faults

/** Shown first: the faults that say the supply voltage sagged or the device rebooted. */
export const POWER_FAULTS = ['Undervoltage', 'BridgeBrownout', 'BootDuringEnable']

export interface StickyFault { name: string; signal: string; id: number; value: boolean | null; raw: string }

export interface DeviceFaults {
  device: Device
  /** The profile's name for the motor, when it has one. */
  label: string
  set: StickyFault[]
  unreadable: StickyFault[]
  checked: number
}

const order = (name: string) => { const i = POWER_FAULTS.indexOf(name); return i === -1 ? POWER_FAULTS.length : i }

/**
 * Each device's sticky faults. The fault names come from that device's own signal list (getsignals); their ids are
 * looked up there every time, because ids change between Phoenix versions. The value is read from the self-test.
 */
export function stickyFaults(snapshot: Snapshot, profile: SnapshotProfile | null): DeviceFaults[] {
  const names = new Map<string, string>()
  for (const g of profile?.motorGroups ?? []) for (const m of g.motors) if (m.canId !== undefined) names.set(String(m.canId), m.name)
  const out: DeviceFaults[] = []
  for (const device of snapshot.devices) {
    if (!device.signals || !device.selfTest) continue
    const faults = device.signals.filter((s) => s.name.startsWith('StickyFault_')).map((s): StickyFault => {
      const row = device.selfTest![String(s.id)] ?? device.selfTest![s.name]
      const raw = row === undefined ? '(not in the self-test)' : String(row.Value)
      return { name: s.name.slice('StickyFault_'.length), signal: s.name, id: s.id, value: row === undefined ? null : parseBool(row.Value), raw }
    })
    const sorted = faults.sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name))
    const label = (device.isMotor && names.get(String(device.id))) || `${device.model} ${device.id}`
    out.push({ device, label, set: sorted.filter((f) => f.value === true), unreadable: sorted.filter((f) => f.value === null), checked: faults.length })
  }
  const worst = (d: DeviceFaults) => Math.min(...d.set.map((f) => order(f.name)), 99)
  return out.sort((a, b) => worst(a) - worst(b) || b.set.length - a.set.length)
}

// ---------------------------------------------------------------------------------------------------------------
// The limits wizard: did the setting take, read straight from the motors

export interface ProofRow { motor: string; verdict: 'set' | 'not set' | 'not checked'; detail: string }

/**
 * For a wizard step: does every motor in the group hold the step's setting? A limit: SupplyCurrentLimit = limitA,
 * enabled, LowerTime = 0. No limit (null): supply limit switched off.
 */
export function stepProof(snapshot: Snapshot, group: MotorGroup, limitA: number | null): { rows: ProofRow[]; ok: boolean; notSet: number; notChecked: number } {
  const rows = group.motors.map((motor): ProofRow => {
    if (motor.canId === undefined) return { motor: motor.name, verdict: 'not checked', detail: 'no CAN ID in the profile' }
    const devices = snapshot.devices.filter((d) => d.isMotor && d.id === motor.canId)
    if (devices.length !== 1 || devices[0].count > 1) return { motor: motor.name, verdict: 'not checked', detail: devices.length ? `CAN ID ${motor.canId} is on more than one device` : `CAN ID ${motor.canId} isn't on the bus` }
    const d = devices[0]
    if (!d.configs) return { motor: motor.name, verdict: 'not checked', detail: 'its configs weren\'t read' }
    const on = parseBool(configOf(d, 'Config_SupplyCurrLimitEn')?.value)
    const amps = parseNumber(configOf(d, 'Config_SupplyCurrentLimit')?.value)
    const lower = parseNumber(configOf(d, 'Config_SupplyCurrentLowerTime')?.value)
    const now = `supply limit ${amps ?? '?'} A ${on === null ? '(on/off unreadable)' : on ? 'on' : 'off'}, lower time ${lower ?? '?'} s`
    if (on === null || (limitA !== null && (amps === null || lower === null))) return { motor: motor.name, verdict: 'not checked', detail: `unreadable: ${now}` }
    const good = limitA === null ? on === false : on === true && sameNumber(amps!, limitA) && Math.abs(lower!) < 0.001
    return { motor: motor.name, verdict: good ? 'set' : 'not set', detail: now }
  })
  const notSet = rows.filter((r) => r.verdict === 'not set').length
  const notChecked = rows.filter((r) => r.verdict === 'not checked').length
  return { rows, ok: notSet === 0 && notChecked === 0, notSet, notChecked }
}
