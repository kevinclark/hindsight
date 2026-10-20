/**
 * A synthetic robot snapshot built in memory, in the response shapes of tests/robot_snapshot_fixtures.py (CTRE's
 * 26.3.0 simulator): Talon FX devices with a name, CAN ID, bus and applied current limits. No real robot's answers.
 */
import { parseSnapshot, SNAPSHOT_SCHEMA, type Snapshot } from '../../src/snapshot/snapshot.ts'
import type { CurrentLimits } from '../../src/profiles/types.ts'

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
