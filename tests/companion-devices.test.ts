// The Hindsight companion's device and hoot keys (HindsightDevices.watch, /Hindsight/Hoot), read by Hindsight: the
// reboot rule, companion-only devices in can/device-dropout, the Logging tab's "not watched" lines and the hoot line.
// No log of ours has these keys yet, so every log here is synthetic, in the shapes companion/keys.json lists.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { coverage } from '../src/coverage/coverage.ts'
import { hex32, versionText } from '../src/match/companion.ts'
import { writeWpilog, type FixtureEntry, type FixtureValue } from './helpers/fixture-format.ts'
import { fired } from './helpers/load.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { allMotors, draftProfile } from '../src/builder/draft.ts'

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

  it('leaves a count that rose while the device wasn\'t answering to the drop', () => {
    const r = { resets: perSecond(0, [[25, 1]]), connected: perSecond(true, [[25, false], [26, true]]) }
    expect(fired(run(watched('Any', 'TalonFX', 15, r)))).not.toContain('can/device-rebooted')
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

  it('counts a companion-only drop as together with a profile device\'s up to 2 s apart (a read later)', () => {
    const flag: FixtureEntry = { name: '/Drum/Flywheel/Leader/Connected', type: 'boolean', records: [[10, true], [25, false], [28, true]] }
    const report = run([flag, ...watched('Any', 'TalonFX', 40, { connected: perSecond(true, [[26, false], [29, true]]) })])
    const f = findings(report, 'can/device-dropout').find((x) => x.about === 'TalonFX 40 on Any')!
    expect(f.evidence['other devices dropped at the same moment']).toBe('Flywheel leader')
  })

  it('checks both of two same-ID devices on two buses (neither takes the profile\'s flag or name)', () => {
    const flag: FixtureEntry = { name: '/Drum/Flywheel/Leader/Connected', type: 'boolean', records: [[10, true]] }
    const off = { connected: perSecond(true, [[25, false], [28, true]]) }
    const report = run([flag, ...watched('rio', 'TalonFX', 15, off), ...watched('canivore', 'TalonFX', 15)])
    expect(findings(report, 'can/device-dropout').map((f) => f.about)).toEqual(['TalonFX 15 on rio'])
  })

  it('is not checked from a companion reading taken in simulation or replay ("not read")', () => {
    const report = run(watched('Any', 'TalonFX', 40, { connected: perSecond(false), status: 'not read' }))
    expect(findings(report, 'can/device-dropout').map((f) => f.about)).not.toContain('TalonFX 40 on Any')
    expect(report.skipped.find((s) => s.rule === 'can/device-dropout')?.reason).toMatch(/TalonFX 40 on Any: the Hindsight companion didn't read it \(not read\)/)
  })

  it('still checks companion-only devices on a log the profile doesn\'t fit', () => {
    const a = analyzeFiles([{ name: 'x.wpilog', bytes: writeWpilog([...base, ...watched('Any', 'TalonFX', 40, { connected: perSecond(true, [[25, false], [28, true]]) })]) }]).analyses[0]
    expect(a.match.profileChoice.misfit).toBeTruthy()
    expect(findings(a.report, 'can/device-dropout').map((f) => f.about)).toEqual(['TalonFX 40 on Any'])
  })

  it('says a device that never answered may have its status signals turned off', () => {
    const report = run(watched('rio', 'CANdle', 3, { connected: perSecond(false) }))
    const [f] = findings(report, 'can/device-dropout').filter((x) => x.about === 'CANdle 3 on rio')
    expect(f.nextStep).toMatch(/optimizeBusUtilization/)
  })
})

describe('Logging tab: motors whose IO logs no Device key', () => {
  const lines = (extra: FixtureEntry[]) => {
    const a = analyze(extra)
    return coverage(a.match, a.report).lines.filter((l) => l.what.endsWith('Device key (Hindsight companion)'))
  }
  const deviceKey = (name: string, value: string): FixtureEntry => ({ name, type: 'string', records: [[10, value]] })

  it('lists nothing on a robot without the companion', () => {
    expect(lines([])).toEqual([])
  })

  it('marks each profile motor by its Device key, named like its IO\'s other keys', () => {
    const got = lines([...watched('Any', 'TalonFX', 15), deviceKey('/Drum/Flywheel/Leader/Device', 'Any/TalonFX/15'), deviceKey('/Swerve/Front Left Module/DriveDevice', 'Any/TalonFX/0')])
    expect(got).toHaveLength(19) // the 2026 profile's motors
    const line = (motor: string) => got.find((l) => l.what === `${motor} Device key (Hindsight companion)`)!
    expect(line('Flywheel leader')).toMatchObject({ state: 'logged', key: '/Drum/Flywheel/Leader/Device' })
    expect(line('Front Left drive')).toMatchObject({ state: 'logged', key: '/Swerve/Front Left Module/DriveDevice' })
    expect(line('Hood')).toMatchObject({ state: 'not logged', key: '/Drum/Hood/Device' })
    expect(line('Hood').todo).toMatch(/HindsightDevices\.watch and log the key it returns as \/Drum\/Hood\/Device/)
    expect(line('Hood').dark.map((d) => d.rule)).toEqual(['can/device-rebooted'])
  })

  it('lists every motor as not watched when the companion runs but no IO logs a Device key', () => {
    const got = lines([{ name: '/Hindsight/System/Status', type: 'string', records: [[10, 'ok']] }])
    expect(got.every((l) => l.state === 'not logged')).toBe(true)
  })
})

describe('joining a watched device to the profile', () => {
  const about = (extra: FixtureEntry[]) => findings(run(extra), 'can/device-rebooted').map((f) => f.about)
  const reboot = { resets: perSecond(0, [[25, 1]]) }

  it('is exact through the motor\'s Device key, whatever its CAN ID in the profile', () => {
    const key: FixtureEntry = { name: '/Drum/Hood/Device', type: 'string', records: [[10, 'canivore/TalonFX/44']] }
    expect(about([key, ...watched('canivore', 'TalonFX', 44, reboot)])).toEqual(['Hood (TalonFX 44)'])
  })

  it('falls back to model and CAN ID, but names neither of two same-ID devices on two buses after the profile', () => {
    expect(about(watched('Any', 'TalonFX', 14, reboot))).toEqual(['Hood (TalonFX 14)'])
    expect(about([...watched('rio', 'TalonFX', 14, reboot), ...watched('canivore', 'TalonFX', 14, reboot)])).toEqual(['TalonFX 14 on canivore', 'TalonFX 14 on rio'])
  })
})

describe('the profile builder reads the companion\'s Device key as the CAN ID', () => {
  it('in both naming forms', () => {
    const entries: FixtureEntry[] = [
      ...base,
      ...['/Shooter/Leader/', '/Swerve/FL/Drive'].flatMap((p): FixtureEntry[] => [
        { name: `${p}SupplyCurrentAmps`, type: 'double', records: [[10, 1], [20, 2]] },
        { name: `${p}Connected`, type: 'boolean', records: [[10, true]] },
      ]),
      { name: '/Shooter/Leader/Device', type: 'string', records: [[10, 'Any/TalonFX/21']] },
      { name: '/Swerve/FL/DriveDevice', type: 'string', records: [[10, 'rio/TalonFX/3']] },
    ]
    const draft = draftProfile({ logs: [{ log: openWpilog(writeWpilog(entries)), fileName: 'x.wpilog' }] })
    const ids = Object.fromEntries(allMotors(draft.json).map(({ motor }) => [motor.logPath, [motor.canId, motor.canIdFrom]]))
    expect(ids).toEqual({ '/Shooter/Leader': [21, 'log'], '/Swerve/FL/Drive': [3, 'log'] })
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
    const quiet = run([])
    const off = run(hoot(perSecond(false)))
    expect(off.findings.map((f) => f.rule)).toEqual(quiet.findings.map((f) => f.rule))
  })
})

describe('companion value formats', () => {
  it('reads firmware as major.minor.bugfix.build, major first', () => {
    expect(versionText(0x1a010002)).toBe('26.1.0.2')
  })
  it('shows a fault field as 8-digit hex', () => {
    expect(hex32(0x104)).toBe('0x00000104')
  })
})
