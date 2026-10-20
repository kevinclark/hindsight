// The Hindsight companion's device and hoot keys (HindsightDevices.watch, /Hindsight/Hoot), read by Hindsight: the
// reboot rule, companion-only devices in can/device-dropout, the Logging tab's "not watched" lines and the hoot line.
// No log of ours has these keys yet, so every log here is synthetic, in the shapes companion/keys.json lists.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { coverage } from '../src/coverage/coverage.ts'
import { faultFieldText, hootLine, versionText } from '../src/match/companion.ts'
import { writeWpilog, type FixtureEntry, type FixtureValue } from './helpers/fixture-format.ts'
import { fired } from './helpers/load.ts'

const base: FixtureEntry[] = [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.6]] },
]

/** A value read once a second from 10 s to 40 s, changing to `then` at `at` (and back to `after` at `back`). */
function perSecond(first: FixtureValue, change: [number, FixtureValue][] = []): [number, FixtureValue][] {
  const out: [number, FixtureValue][] = []
  for (let t = 10; t <= 40; t++) out.push([t, [...change].reverse().find(([at]) => t >= at)?.[1] ?? first])
  return out
}

interface DeviceReadings { connected?: [number, FixtureValue][]; resets?: [number, FixtureValue][]; sticky?: number; version?: number; status?: string }

/** One watched device's keys, as the companion logs them: answering, firmware 26.1.0.0, no faults, no reboots. */
function watched(bus: string, model: string, id: number, r: DeviceReadings = {}): FixtureEntry[] {
  const at = `/Hindsight/Devices/${bus}/${model}/${id}`
  return [
    { name: `${at}/Connected`, type: 'boolean', records: r.connected ?? perSecond(true) },
    { name: `${at}/Resets`, type: 'int64', records: r.resets ?? perSecond(0) },
    { name: `${at}/Version`, type: 'int64', records: [[10, r.version ?? 0x1a010000]] },
    { name: `${at}/FaultField`, type: 'int64', records: [[10, 0]] },
    { name: `${at}/StickyFaultField`, type: 'int64', records: [[10, r.sticky ?? 0]] },
    { name: `${at}/ProLicensed`, type: 'boolean', records: [[10, true]] },
    { name: `${at}/Status`, type: 'string', records: [[10, r.status ?? 'OK']] },
  ]
}

/** The base log with these entries added (an entry named like a base one replaces it). */
function analyze(extra: FixtureEntry[]) {
  const entries = [...base.filter((b) => !extra.some((e) => e.name === b.name)), ...extra]
  return analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0]
}
const run = (extra: FixtureEntry[]) => analyze(extra).report
const findings = (report: ReturnType<typeof run>, rule: string) => report.findings.filter((f) => f.rule === rule)

describe('can/device-rebooted', () => {
  it('is not checked, with why, on a robot that watches no device', () => {
    const report = run([])
    expect(report.skipped.find((s) => s.rule === 'can/device-rebooted')?.reason).toMatch(/watches no CTRE device with the Hindsight companion/)
  })

  it('fires when the reboot count rises while enabled, naming the device as the profile does', () => {
    const report = run([...watched('Any', 'TalonFX', 15, { resets: perSecond(0, [[25, 1]]) }), ...watched('Any', 'TalonFX', 40)])
    const [f] = findings(report, 'can/device-rebooted')
    expect(f.about).toBe('Flywheel leader (TalonFX 15)')
    expect(f.title).toMatch(/^Flywheel leader \(TalonFX 15\) rebooted 1 time, first at /)
    expect(f.time).toBe(25)
    expect(f.evidence['lowest battery voltage in the 1.5 s before each reboot (V)']).toBe('12.60')
    expect(f.evidence['other devices rebooted at the same moment']).toBe('none')
    expect(f.causes.find((c) => c.id === 'battery-sag')?.ruledOut).toMatch(/above 7.5 V/)
    expect(f.causes[0]).toMatchObject({ id: 'device-power', likely: true })
  })

  it('points at shared power when two devices reboot in the same read, and at the battery when it sagged', () => {
    const sag: FixtureEntry = { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.6], [24.5, 6.2], [25.2, 12]] }
    const report = run([sag, ...watched('Any', 'TalonFX', 15, { resets: perSecond(0, [[25, 1]]) }), ...watched('Any', 'CANcoder', 4, { resets: perSecond(0, [[26, 1]]) })])
    const f = findings(report, 'can/device-rebooted').find((x) => x.about === 'Flywheel leader (TalonFX 15)')!
    expect(f.evidence['other devices rebooted at the same moment']).toBe('Intake CANcoder (CANcoder 4)')
    expect(f.causes.filter((c) => c.likely).map((c) => c.id)).toEqual(['battery-sag', 'shared-power'])
    expect(f.causes.find((c) => c.id === 'device-fault')?.ruledOut).toBe('1 other device rebooted at the same moment')
  })

  it('stays quiet on a reboot while disabled (before the first enable)', () => {
    expect(fired(run(watched('Any', 'TalonFX', 15, { resets: perSecond(0, [[15, 1]]) })))).not.toContain('can/device-rebooted')
  })
})

describe('can/device-dropout over companion-only devices', () => {
  it('fires for a watched device the profile has no Connected flag for, reading the battery 1.5 s back', () => {
    const report = run(watched('Any', 'TalonFX', 40, { connected: perSecond(true, [[25, false], [28, true]]) }))
    const [f] = findings(report, 'can/device-dropout').filter((x) => x.about === 'TalonFX 40 on Any')
    expect(f.title).toMatch(/^TalonFX 40 on Any dropped off CAN 1 time/)
    expect(f.evidence['read by']).toBe('the Hindsight companion (HindsightDevices.watch), once a second')
    expect(f.evidence['lowest battery voltage in the 1.5 s before each drop (V)']).toBe('12.60')
  })

  it('leaves a device to the profile\'s own Connected flag when the log has it (no second finding)', () => {
    const flag: FixtureEntry = { name: '/Drum/Flywheel/Leader/Connected', type: 'boolean', records: [[10, true]] }
    const report = run([flag, ...watched('Any', 'TalonFX', 15, { connected: perSecond(true, [[25, false], [28, true]]) })])
    expect(findings(report, 'can/device-dropout').map((f) => f.about)).not.toContain('Flywheel leader (TalonFX 15)')
  })

  it('says a device that never answered may have its status signals turned off', () => {
    const report = run(watched('rio', 'CANdle', 3, { connected: perSecond(false) }))
    const [f] = findings(report, 'can/device-dropout').filter((x) => x.about === 'CANdle 3 on rio')
    expect(f.nextStep).toMatch(/optimizeBusUtilization/)
  })
})

describe('Logging tab: devices the companion does not watch', () => {
  const lines = (extra: FixtureEntry[]) => {
    const a = analyze(extra)
    return coverage(a.match, a.report).lines.filter((l) => l.what.endsWith('watched by the Hindsight companion'))
  }

  it('lists nothing on a robot without the companion', () => {
    expect(lines([])).toEqual([])
  })

  it('marks each profile device with a CAN ID watched or not, by model and ID', () => {
    const got = lines([...watched('Any', 'TalonFX', 15), ...watched('Any', 'CANcoder', 4), ...watched('Any', 'Pigeon2', 0)])
    // 19 motors, 5 CANcoders and the gyro in the 2026 profile
    expect(got).toHaveLength(25)
    const state = (what: string) => got.find((l) => l.what === `${what} watched by the Hindsight companion`)!
    expect(state('Flywheel leader')).toMatchObject({ state: 'logged', found: '/Hindsight/Devices/Any/TalonFX/15' })
    expect(state('Intake CANcoder')).toMatchObject({ state: 'logged' })
    expect(state('Gyro (Pigeon)')).toMatchObject({ state: 'logged' })
    // CAN ID 0 is both the gyro and the front-left drive motor: the model tells them apart.
    expect(state('Front Left drive')).toMatchObject({ state: 'not logged', key: '/Hindsight/Devices/…/TalonFX or TalonFXS/0' })
    expect(state('Front Left drive').todo).toMatch(/HindsightDevices\.watch/)
    expect(state('Front Left drive').dark.map((d) => d.rule)).toEqual(['can/device-rebooted'])
  })

  it('lists every device as not watched when the companion runs but watches none', () => {
    const got = lines([{ name: '/Hindsight/System/Status', type: 'string', records: [[10, 'ok']] }])
    expect(got.every((l) => l.state === 'not logged')).toBe(true)
  })
})

describe('hoot recording (context line)', () => {
  const hoot = (recording: [number, FixtureValue][], status = 'ok') => [
    { name: '/Hindsight/Hoot/Recording', type: 'boolean', records: recording },
    { name: '/Hindsight/Hoot/Status', type: 'string', records: [[10, status]] },
    { name: '/Hindsight/Hoot/NewestFile', type: 'string', records: [[10, '/U/logs/2026-10-20_12-00-00/rio_2026-10-20_12-00-00.hoot']] },
    { name: '/Hindsight/Hoot/NewestSizeBytes', type: 'int64', records: [[10, 41_200_000]] },
  ] as FixtureEntry[]
  const line = (extra: FixtureEntry[]) => { const a = analyze(extra); return coverage(a.match, a.report).hoot }

  it('is absent without the companion', () => {
    expect(line([])).toBeNull()
  })
  it('says recording for the whole match, with the newest file', () => {
    expect(line(hoot(perSecond(true)))).toMatchObject({ state: 'whole' })
    expect(line(hoot(perSecond(true)))!.text).toMatch(/^Phoenix hoot was recording during the match .*Newest file: rio_2026-10-20_12-00-00\.hoot \(41\.2 MB\)\.$/)
  })
  it('says for how long when it stopped part way', () => {
    expect(line(hoot(perSecond(true, [[30, false]])))).toMatchObject({ state: 'part', text: expect.stringMatching(/for 10 of the 15 s during the match/) })
  })
  it('says not recording, and unknown when the companion could not look', () => {
    expect(line(hoot(perSecond(false), 'no hoot files'))).toMatchObject({ state: 'off' })
    expect(line(hoot(perSecond(false), 'unavailable: no log folder'))).toMatchObject({ state: 'unknown', text: expect.stringMatching(/no log folder/) })
  })
  it('never becomes a finding', () => {
    expect([...fired(run(hoot(perSecond(false))))].filter((r) => r.includes('hoot'))).toEqual([])
    expect(hootLine).toBeTypeOf('function')
  })
})

describe('companion value formats', () => {
  it('reads firmware as major.minor.bugfix.build, major first', () => {
    expect(versionText(0x1a010002)).toBe('26.1.0.2')
  })
  it('shows a fault field as 8-digit hex', () => {
    expect(faultFieldText(0x104)).toBe('0x00000104')
  })
})
