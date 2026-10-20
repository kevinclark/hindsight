/**
 * A synthetic robot snapshot built in memory, in the response shapes of tests/robot_snapshot_fixtures.py (CTRE's
 * 26.3.0 simulator): Talon FX devices with a name, CAN ID, bus and applied current limits. No real robot's answers.
 */
import { parseSnapshot, SNAPSHOT_SCHEMA, type Snapshot } from '../../src/snapshot/snapshot.ts'
import type { CurrentLimits, RobotProfile } from '../../src/profiles/types.ts'
import { LIMIT_FIELDS } from '../../src/snapshot/report.ts'

export interface FakeTalon {
  id: number
  bus?: string
  /** Tuner X name; default "Talon FX vers. C (Device ID n)". */
  name?: string
  /** Applied limits; a field left out reads as Phoenix 6's default. */
  limits?: Partial<CurrentLimits>
}

const PHOENIX_DEFAULTS = { statorA: 120, statorEnabled: true, supplyA: 70, supplyEnabled: true, supplyLowerA: 40, supplyLowerSeconds: 1 }
const SIGNALS: [string, keyof typeof PHOENIX_DEFAULTS, 'double' | 'bool', number][] = [
  ['Config_StatorCurrentLimit', 'statorA', 'double', 1906],
  ['Config_StatorCurrLimitEn', 'statorEnabled', 'bool', 1907],
  ['Config_SupplyCurrentLimit', 'supplyA', 'double', 1908],
  ['Config_SupplyCurrLimitEn', 'supplyEnabled', 'bool', 1909],
  ['Config_SupplyCurrentLowerLimit', 'supplyLowerA', 'double', 1992],
  ['Config_SupplyCurrentLowerTime', 'supplyLowerSeconds', 'double', 1993],
]
const MODEL = 'Talon FX vers. C'

/** The snapshot as the raw snapshot.json text, for a test that drops it into the page. */
export function makeSnapshotJson(talons: FakeTalon[], takenAt = '2026-01-01T12:00:00Z'): string {
  const devices: Record<string, unknown> = {}
  const array = talons.map((t) => {
    const bus = t.bus ?? 'canivore1'
    const key = `${bus}|${MODEL}|${t.id}`
    const value = (k: keyof typeof PHOENIX_DEFAULTS) => (t.limits?.[k] as number | boolean | undefined) ?? PHOENIX_DEFAULTS[k]
    devices[key] = {
      count: 1,
      getconfigv2: {
        GeneralReturn: { Action: 'getconfigv2', CANbus: bus, Error: 0, ErrorMessage: '', ID: t.id, Model: MODEL },
        JsonVersion: 2,
        Device: [{
          Name: 'Current Limits',
          Configs: SIGNALS.map(([signal, k, type, id]) => ({
            SignalId: id, SignalName: signal, Name: signal, Type: type, Units: type === 'bool' ? '' : k === 'supplyLowerSeconds' ? 's' : 'A',
            Value: type === 'bool' ? (value(k) ? 1 : 0) : value(k), DefaultValue: type === 'bool' ? 1 : PHOENIX_DEFAULTS[k],
          })),
        }],
      },
    }
    return { CANbus: bus, ID: t.id, Model: MODEL, Name: t.name ?? `${MODEL} (Device ID ${t.id})`, CurrentVers: '26.3.0.0 (Phoenix 6)', SerialNo: `SIM-${String(t.id).padStart(4, '0')}` }
  })
  const raw = {
    schema: SNAPSHOT_SCHEMA, takenAt, takenAtLocal: takenAt, collector: { version: 'test' }, responseShapes: 'simulator', provenance: 'synthetic test snapshot',
    getdevices: { body: { GeneralReturn: { Action: 'getdevices', Error: 0 }, BusUtilPerc: 20, DeviceArray: array } },
    devices,
  }
  return JSON.stringify(raw)
}

export function makeSnapshot(talons: FakeTalon[], takenAt = '2026-01-01T12:00:00Z'): Snapshot {
  return parseSnapshot(makeSnapshotJson(talons, takenAt), 'synthetic-snapshot.json')
}

/**
 * Any CTRE device, for the Foresight snapshot checks: its configs by signal name (any group), its self-test values by
 * signal name (each also listed in getsignals, ids made up), and how many devices answer to its ID.
 */
export interface FakeDevice {
  model: string
  id: number
  bus?: string
  configs?: Record<string, number | boolean>
  selfTest?: Record<string, boolean | string>
  pro?: boolean
  /** 2+: that many devices share this model and ID on the bus. */
  count?: number
  /** Not read by the collector, and why. */
  skipped?: string
}

const DEFAULT_OF = new Map(SIGNALS.map(([signal, k]) => [signal, Number(PHOENIX_DEFAULTS[k])]))

export function makeDevicesSnapshotJson(fakes: FakeDevice[], takenAt: string): string {
  const devices: Record<string, unknown> = {}
  const array: unknown[] = []
  const skipped: unknown[] = []
  fakes.forEach((d, n) => {
    const bus = d.bus ?? 'canivore1'
    const key = `${bus}|${d.model}|${d.id}`
    for (let i = 0; i < (d.count ?? 1); i++) array.push({ CANbus: bus, ID: d.id, Model: d.model, Name: `${d.model} (Device ID ${d.id})`, CurrentVers: '26.3.0.0 (Phoenix 6)', SerialNo: `SIM-${n}-${i}`, IsPROLicensed: d.pro ?? true })
    if (d.skipped) { skipped.push({ device: key, reason: d.skipped }); return }
    const names = Object.keys(d.selfTest ?? {})
    devices[key] = {
      getconfigv2: d.configs && { JsonVersion: 2, Device: [{ Name: 'All', Configs: Object.entries(d.configs).map(([signal, value], i) => ({ SignalId: 5000 + i, SignalName: signal, Name: signal, Type: typeof value === 'boolean' ? 'bool' : 'double', Value: typeof value === 'boolean' ? (value ? 1 : 0) : value, DefaultValue: DEFAULT_OF.get(signal) ?? 0, Units: '' })) }] },
      getsignals: d.selfTest && { Signals: names.map((name, i) => ({ Id: 9000 + i, Name: name, Units: '' })) },
      decoratedselftest: d.selfTest && { SelfTest: Object.fromEntries(names.map((name, i) => [String(9000 + i), { Value: String(d.selfTest![name]) }])) },
    }
  })
  return JSON.stringify({
    schema: SNAPSHOT_SCHEMA, takenAt, takenAtLocal: takenAt, collector: { version: 'test' }, responseShapes: 'simulator', provenance: 'synthetic test snapshot',
    getdevices: { body: { GeneralReturn: { Action: 'getdevices', Error: 0 }, BusUtilPerc: 20, DeviceArray: array } },
    devices, skipped,
  })
}

export const makeDevicesSnapshot = (fakes: FakeDevice[], takenAt: string): Snapshot => parseSnapshot(makeDevicesSnapshotJson(fakes, takenAt), 'synthetic-snapshot.json')

const LICENCE = { Fault_UnlicensedFeatureInUse: false, StickyFault_UnlicensedFeatureInUse: false }
export const TALON_LICENCE = { ...LICENCE, Fault_TALONFX_UsingFusedCCWhileUnlicensed: false, StickyFault_TALONFX_UsingFusedCCWhileUnlicensed: false }

/** A robot as its profile says the code configures it: every motor, CANcoder and gyro, each running what the code sets. */
export function profileSnapshot(profile: RobotProfile): FakeDevice[] {
  const expected = profile.foresight?.snapshot ?? { devices: [], ratios: [] }
  const motors = profile.motorGroups.flatMap((group) => group.motors.map((motor): FakeDevice => {
    const configs: Record<string, number | boolean> = {}
    for (const f of LIMIT_FIELDS) if (group.limits[f.key] !== undefined) configs[f.signal] = group.limits[f.key] as number | boolean
    const ratio = expected.ratios.find((r) => r.group === group.name)
    if (ratio?.sensorToMechanism !== undefined) configs.Config_SensorToMechanismRatio = ratio.sensorToMechanism
    if (ratio?.rotorToSensor !== undefined) configs.Config_RotorToSensorRatio = ratio.rotorToSensor
    const reads = expected.devices.find((d) => d.readBy === motor.canId)
    if (reads) configs.Config_FeedbackRemoteSensorID = reads.canId
    return { model: 'Talon FX vers. C', id: motor.canId!, configs, selfTest: TALON_LICENCE }
  }))
  // Phoenix's defaults for the limits the profile leaves out.
  const defaults = Object.fromEntries(SIGNALS.map(([signal, k]) => [signal, PHOENIX_DEFAULTS[k]]))
  for (const m of motors) m.configs = { ...defaults, ...m.configs }
  const others = expected.devices.map((d): FakeDevice => ({
    model: d.model === 'CANcoder' ? 'CANCoder vers. H' : 'Pigeon 2', id: d.canId, selfTest: LICENCE,
    configs: d.magnetOffset === undefined ? undefined : { CANCoder_MagnetOffset: d.magnetOffset },
  }))
  return [...motors, ...others]
}

