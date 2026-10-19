// Robot snapshot analysis: parsing, profile choice, inventory, limits, sticky faults, the wizard proof, and diffs.
// Fixtures are synthetic (see tests/robot_snapshot_fixtures.py); modified copies are built in memory.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { busLabel, configOf, parseBool, parseSnapshot, type Snapshot } from '../src/snapshot/snapshot.ts'
import { chooseProfile, inventory, limitsReport, stepProof, stickyFaults, type SnapshotProfile } from '../src/snapshot/report.ts'
import { diffSnapshots } from '../src/snapshot/diff.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */
const read = (f: string) => readFileSync(`fixtures/robot-snapshot/${f}`, 'utf8')
const rawBefore = () => JSON.parse(read('snapshot-before.json')) as any
const rawAfter = () => JSON.parse(read('snapshot-after.json')) as any
const parse = (raw: any, name = 'x.json') => parseSnapshot(JSON.stringify(raw), name)
const profile = () => JSON.parse(read('example-profile.json')) as SnapshotProfile
const before = parseSnapshot(read('snapshot-before.json'), 'snapshot-before.json')
const after = parseSnapshot(read('snapshot-after.json'), 'snapshot-after.json')
const TALON = 'canivore1|Talon FX vers. C|'
const decoy: SnapshotProfile = { name: 'Decoy', motorGroups: [{ name: 'G', motors: [{ name: 'm', canId: 99 }], limits: { where: 'x' } } as any] }

/** Set a config's Value on a raw snapshot's device. */
function setConfig(raw: any, key: string, signal: string, value: unknown) {
  for (const g of raw.devices[key].getconfigv2.Device) for (const c of g.Configs) if (c.SignalName === signal) c.Value = value
}
const shooter = (p: SnapshotProfile) => p.motorGroups.find((g) => g.name === 'Shooter')!

describe('profile choice and inventory', () => {
  it('chooses the profile whose CAN IDs are on the bus', () => {
    expect(chooseProfile(before, [decoy, profile()])?.name).toBe('Example robot')
    expect(chooseProfile(before, [decoy])).toBeNull()
  })

  it('lists found, missing, extra and other devices', () => {
    const rows = inventory(before, profile())
    expect(rows.filter((r) => r.status === 'found')).toHaveLength(7)
    const missing = rows.filter((r) => r.status === 'missing')
    expect(missing).toHaveLength(1)
    expect(missing[0].motor?.name).toBe('Intake roller')
    expect(missing[0].motor?.canId).toBe(20)
    const extra = rows.filter((r) => r.status === 'extra')
    expect(extra).toHaveLength(1)
    expect(extra[0].devices[0].model).toMatch(/^Talon FX/)
    expect(extra[0].devices[0].id).toBe(30)
    const other = rows.filter((r) => r.status === 'other')
    expect(other.map((r) => r.devices[0].model).sort()).toEqual(['CANCoder vers. H', 'CANdle', 'Pigeon 2'])
    expect(other.find((r) => r.devices[0].model === 'CANdle')!.note).toMatch(/not read/i)
    expect(rows).toHaveLength(7 + 1 + 1 + 3)
  })
})

describe('limitsReport', () => {
  const report = limitsReport(before, profile())
  const group = (n: string) => report.groups.find((g) => g.group === n)!

  it('Drive is clean', () => {
    expect(group('Drive').status).toBe('clean')
    expect(group('Drive').motors).toHaveLength(4)
    expect(group('Drive').motors.every((m) => m.status === 'ok')).toBe(true)
  })

  it('Shooter differs on follower 12 supply limit only', () => {
    const s = group('Shooter')
    expect(s.status).toBe('differs')
    const bad = s.motors.filter((m) => m.status === 'differs')
    expect(bad).toHaveLength(1)
    expect(bad[0].motor).toBe('Shooter follower 12')
    const notOk = bad[0].fields.filter((f) => f.ok !== true)
    expect(notOk).toHaveLength(1)
    expect(notOk[0].label).toBe('supply limit')
    expect(notOk[0].applied).toBe(60)
    expect(notOk[0].expected).toBe(40)
    expect(notOk[0].expectedFrom).toBe('profile')
    expect(s.disagree).toEqual(['supply limit'])
  })

  it('Intake is not checked, its motor not on the bus', () => {
    expect(group('Intake').status).toBe('not-checked')
    expect(group('Intake').motors.map((m) => m.status)).toEqual(['not-on-bus'])
  })

  it('lists the Talon with its supply limit off that no group claims', () => {
    expect(report.supplyOffElsewhere.map((d) => d.id)).toEqual([30])
  })

  it('uses the Phoenix default for fields the profile omits', () => {
    const f = group('Drive').motors[0].fields
    const lowerA = f.find((x) => x.label === 'supply lower limit')!
    const lowerS = f.find((x) => x.label === 'supply lower time')!
    expect([lowerA.expectedFrom, lowerA.expected]).toEqual(['Phoenix default', 40])
    expect([lowerS.expectedFrom, lowerS.expected]).toEqual(['Phoenix default', 1])
    expect(lowerA.ok).toBe(true)
  })

  it('reads nothing without a profile', () => {
    const r = limitsReport(before, null)
    expect(r.groups).toEqual([])
    expect(r.supplyOffElsewhere.map((d) => d.id)).toEqual([30])
  })
})

describe('stickyFaults', () => {
  const faults = stickyFaults(before, profile())

  it('finds exactly Shooter follower 11 with Undervoltage', () => {
    const withSet = faults.filter((d) => d.set.length > 0)
    expect(withSet).toHaveLength(1)
    expect(withSet[0].label).toBe('Shooter follower 11')
    expect(withSet[0].set.map((f) => f.name)).toEqual(['Undervoltage'])
    expect(faults.every((d) => d.unreadable.length === 0)).toBe(true)
    expect(faults[0].label).toBe('Shooter follower 11')
  })

  it('orders power faults first in each list', () => {
    const talon = faults.find((d) => d.label === 'Shooter leader')!
    expect(talon.checked).toBeGreaterThan(3)
    const names = [...talon.set, ...talon.unreadable]
    expect(names).toEqual([])
    // the unfiltered order is visible through a modified copy where several faults are set
    const raw = rawBefore()
    const st = raw.devices[`${TALON}10`].decoratedselftest.SelfTest
    for (const id of ['10002', '10011', '10014', '10050', '10092']) st[id].Value = 'true'
    const set = stickyFaults(parse(raw), profile()).find((d) => d.label === 'Shooter leader')!.set.map((f) => f.name)
    expect(set).toEqual(['Undervoltage', 'BridgeBrownout', 'BootDuringEnable', 'Hardware', 'StatorCurrLimit'])
  })

  it('resolves ids by name: renumbered id, "True", unreadable value, name-keyed row', () => {
    const raw = rawBefore()
    const dev = raw.devices[`${TALON}11`]
    for (const s of dev.getsignals.Signals) if (s.Name === 'StickyFault_Undervoltage') s.Id = 77777
    const st = dev.decoratedselftest.SelfTest
    st['77777'] = { Units: '', Value: 'True' }
    delete st['10011']
    st['10095'].Value = 'maybe' // StickyFault_SupplyCurrLimit
    // leader: BridgeBrownout row keyed by signal name instead of id
    const lead = raw.devices[`${TALON}10`].decoratedselftest.SelfTest
    delete lead['10050']
    lead['StickyFault_BridgeBrownout'] = { Units: '', Value: 'true' }

    const out = stickyFaults(parse(raw), profile())
    const f11 = out.find((d) => d.label === 'Shooter follower 11')!
    expect(f11.set.map((f) => f.name)).toEqual(['Undervoltage'])
    expect(f11.set[0].id).toBe(77777)
    expect(f11.unreadable.map((f) => f.name)).toEqual(['SupplyCurrLimit'])
    expect(f11.set.map((f) => f.name)).not.toContain('SupplyCurrLimit')
    expect(out.find((d) => d.label === 'Shooter leader')!.set.map((f) => f.name)).toEqual(['BridgeBrownout'])
  })
})

describe('diffSnapshots', () => {
  it('orders by takenAt and reports exactly the supply limit change, not live voltage', () => {
    const d = diffSnapshots(after, before)
    expect(d.earlier.fileName).toBe('snapshot-before.json')
    expect(d.later.fileName).toBe('snapshot-after.json')
    expect(d.changes).toHaveLength(1)
    expect(d.changes[0]).toMatchObject({ kind: 'config', before: '60', after: '40' })
    expect(d.changes[0].device).toMatch(/^Talon FX vers\. C 12 /)
  })

  it('the live SupplyVoltage differs between the fixtures but is no change', () => {
    const volts = (s: Snapshot) => s.devices.find((x) => x.id === 12 && x.isMotor)!.selfTest!['1781'].Value
    expect(volts(before)).toBe('12.31')
    expect(volts(after)).toBe('12.18')
    expect(diffSnapshots(before, after).changes.filter((c) => /voltage/i.test(c.field))).toEqual([])
  })
})

describe('duplicate CAN ID', () => {
  it('is ambiguous in inventory and limits', () => {
    const raw = rawBefore()
    const arr = raw.getdevices.body.DeviceArray
    const orig = arr.find((d: any) => d.ID === 11 && /^Talon/.test(d.Model))
    arr.push({ ...orig, SerialNo: 'SIM-0099' })
    const snap = parse(raw)
    const row = inventory(snap, profile()).find((r) => r.motor?.name === 'Shooter follower 11')!
    expect(row.status).toBe('ambiguous')
    expect(row.note).toContain(orig.SerialNo)
    expect(row.note).toContain('SIM-0099')
    const g = limitsReport(snap, profile()).groups.find((x) => x.group === 'Shooter')!
    expect(g.motors.find((m) => m.motor === 'Shooter follower 11')!.status).toBe('ambiguous')
  })
})

describe('supplyOff', () => {
  const raw = rawBefore()
  setConfig(raw, `${TALON}10`, 'Config_SupplyCurrLimitEn', 0)
  const snap = parse(raw)
  const leader = (p: SnapshotProfile) => limitsReport(snap, p).groups.find((g) => g.group === 'Shooter')!

  it('as-profile when the profile says the supply limit is off', () => {
    const p = profile()
    shooter(p).limits.supplyEnabled = false
    const m = leader(p).motors.find((x) => x.motor === 'Shooter leader')!
    expect(m.supplyOff).toBe('as-profile')
    expect(m.fields.find((f) => f.signal === 'Config_SupplyCurrLimitEn')!.ok).toBe(true)
  })

  it('unexpected when the profile says it is on', () => {
    const g = leader(profile())
    const m = g.motors.find((x) => x.motor === 'Shooter leader')!
    expect(m.supplyOff).toBe('unexpected')
    expect(m.status).toBe('differs')
    expect(g.status).toBe('differs')
  })
})

describe('stepProof', () => {
  const lowerTimeZero = () => {
    const raw = rawAfter()
    for (const id of [10, 11, 12]) setConfig(raw, `${TALON}${id}`, 'Config_SupplyCurrentLowerTime', 0)
    return parse(raw)
  }

  it('is not set while the lower time is 1.0', () => {
    const r = stepProof(after, shooter(profile()), 40)
    expect(r.ok).toBe(false)
    expect(r.rows.map((x) => x.verdict)).toEqual(['not set', 'not set', 'not set'])
  })

  it('is ok with a 40 A limit and lower time 0', () => {
    const r = stepProof(lowerTimeZero(), shooter(profile()), 40)
    expect(r.rows.map((x) => x.verdict)).toEqual(['set', 'set', 'set'])
    expect(r.ok).toBe(true)
  })

  it('is ok for no limit when every supply limit is off', () => {
    const raw = rawAfter()
    for (const id of [10, 11, 12]) setConfig(raw, `${TALON}${id}`, 'Config_SupplyCurrLimitEn', 0)
    expect(stepProof(parse(raw), shooter(profile()), null).ok).toBe(true)
    expect(stepProof(after, shooter(profile()), null).ok).toBe(false)
  })

  it('does not check a motor without a CAN ID', () => {
    const p = profile()
    delete shooter(p).motors[1].canId
    const r = stepProof(lowerTimeZero(), shooter(p), 40)
    expect(r.rows[1].verdict).toBe('not checked')
    expect(r.rows[0].verdict).toBe('set')
    expect(r.ok).toBe(false)
  })
})

describe('parseSnapshot', () => {
  const minimal = (extra: object = {}) => JSON.stringify({ schema: 'hindsight.robot-snapshot/1', takenAt: '2026-01-10T18:00:00Z', devices: {}, ...extra })

  it('rejects non-JSON', () => {
    expect(() => parseSnapshot('nope', 'a.json')).toThrow(/a\.json is not JSON/)
  })

  it('rejects another schema and names it', () => {
    expect(() => parseSnapshot(JSON.stringify({ schema: 'other/9', takenAt: 'x', devices: {} }), 'a.json')).toThrow(/other\/9/)
  })

  it('rejects a snapshot with no devices', () => {
    expect(() => parseSnapshot(JSON.stringify({ schema: 'hindsight.robot-snapshot/1', takenAt: 'x' }), 'a.json')).toThrow(/no devices/)
  })

  it('keeps a stopped snapshot with no device list', () => {
    const s = parseSnapshot(minimal({ stopped: { action: 'getdevices', reason: 'robot unreachable' } }))
    expect(s.devices).toEqual([])
    expect(s.stopped?.reason).toBe('robot unreachable')
    expect(s.stopped?.device).toBeNull()
  })

  it('reads the CORS header, any case', () => {
    expect(before.allowOrigin).toBeNull()
    expect(after.allowOrigin).toBeNull()
    expect(before.versionRead).toBe(true)
    const raw = rawBefore()
    raw.getversion.headers.push(['access-control-allow-origin', '*'])
    expect(parse(raw).allowOrigin).toBe('*')
  })

  it('looks configs up by signal name', () => {
    const d = before.devices.find((x) => x.id === 12 && x.isMotor)!
    expect(configOf(d, 'Config_SupplyCurrentLimit')?.value).toBe(60)
    expect(configOf(d, 'Nope')).toBeUndefined()
  })
})

describe('busLabel', () => {
  it('names the roboRIO bus for the empty string', () => {
    expect(busLabel('')).toBe('roboRIO bus')
    expect(busLabel('canivore1')).toBe('canivore1')
  })
})

describe('parseBool', () => {
  it('reads true spellings', () => {
    for (const v of [true, 'TRUE', '1', 1, 'on']) expect(parseBool(v)).toBe(true)
  })
  it('reads false spellings', () => {
    for (const v of [false, 'False', '0', 0]) expect(parseBool(v)).toBe(false)
  })
  it('treats anything else as unreadable', () => {
    for (const v of ['maybe', 2, null, undefined]) expect(parseBool(v)).toBeNull()
  })
})

describe('review fixes', () => {
  it('a motor whose limit settings are all unreadable is never counted as matching', () => {
    const raw = rawBefore()
    for (const id of [1, 2, 3, 4]) {
      for (const group of raw.devices[`${TALON}${id}`].getconfigv2.Device) for (const c of group.Configs) c.SignalName = `Renamed_${c.SignalName}`
    }
    const drive = limitsReport(parse(raw), profile()).groups.find((g) => g.group === 'Drive')!
    expect(drive.motors.map((m) => m.status)).toEqual(['unreadable', 'unreadable', 'unreadable', 'unreadable'])
    expect(drive.status).toBe('not-checked')
  })

  it('one CAN ID on two buses is legal: the note says so and does not ask to renumber', () => {
    const raw = rawBefore()
    raw.getdevices.body.DeviceArray.push({ ...raw.getdevices.body.DeviceArray.find((d: any) => d.ID === 10 && d.Model === 'Talon FX vers. C'), CANbus: '', CANivoreDevName: '', SerialNo: 'SIM-0098' })
    const row = inventory(parse(raw), profile()).find((r) => r.motor?.name === 'Shooter leader')!
    expect(row.status).toBe('ambiguous')
    expect(row.note).toMatch(/more than one bus \(canivore1, roboRIO bus\)/)
    expect(row.note).not.toMatch(/give each its own/)
  })

  it('a Talon FX not matched while profile motors lack CAN IDs says it may be one of them', () => {
    const p = profile()
    delete (p.motorGroups[0].motors[0] as any).canId
    const row = inventory(before, p).find((r) => r.status === 'extra' && r.devices[0].id === 1)!
    expect(row.note).toMatch(/1 of its motors have no CAN ID/)
  })

  it('stepProof separates "not set" from "could not check"', () => {
    const p = profile()
    const g = { ...shooter(p), motors: [...shooter(p).motors, { name: 'Unnumbered' }] }
    const raw = rawAfter()
    for (const id of [10, 11, 12]) setConfig(raw, `${TALON}${id}`, 'Config_SupplyCurrentLowerTime', 0)
    const proof = stepProof(parse(raw), g, 40)
    expect(proof).toMatchObject({ ok: false, notSet: 0, notChecked: 1 })
    const wrong = stepProof(parse(raw), g, 50)
    expect(wrong).toMatchObject({ ok: false, notSet: 3, notChecked: 1 })
  })
})
