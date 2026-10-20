// Foresight's robot-snapshot checks (src/foresight/snapshot-checks.ts) on synthetic snapshots of 8033's robot: a
// healthy one, then one fault at a time. No real robot's answers: the shapes are CTRE's simulator's.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { offseason2026, offseason2026Event } from '../src/profiles/2026-offseason.ts'
import { addSnapshotChecks, OFFSET_TOLERANCE, SNAPSHOT_PROOF, SNAPSHOT_RULES } from '../src/foresight/snapshot-checks.ts'
import { SETTLE_SECONDS } from '../src/foresight/engine.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import { markOnchecks } from '../src/foresight/onchecks.ts'
import type { Report } from '../src/rules/index.ts'
import { makeDevicesSnapshot, profileSnapshot, TALON_LICENCE, type FakeDevice } from './helpers/make-snapshot.ts'

const CODE_START = Date.parse('2026-10-20T17:00:00Z')
const AFTER_SETTLE = new Date(CODE_START + (SETTLE_SECONDS + 30) * 1000).toISOString()
const expected = offseason2026.foresight!.snapshot!
const healthy = () => profileSnapshot(offseason2026)
/** The healthy robot with some devices changed (by model prefix and ID) or added. */
function robot(change: (devices: FakeDevice[]) => FakeDevice[] | void = () => {}): FakeDevice[] {
  const devices = healthy()
  return change(devices) ?? devices
}
const device = (devices: FakeDevice[], model: string, id: number) => devices.find((d) => d.model.startsWith(model) && d.id === id)!

function run(devices: FakeDevice[] | null, takenAt = AFTER_SETTLE, codeStartWallMs: number | null = CODE_START) {
  const report: Report = { findings: [], skipped: [], crashed: [] }
  const used = addSnapshotChecks(report, { snapshot: devices && makeDevicesSnapshot(devices, takenAt), codeStartWallMs }, offseason2026, SETTLE_SECONDS)
  return { report, used, rules: report.findings.filter((f) => f.severity !== 'info').map((f) => f.rule), titles: report.findings.map((f) => f.title) }
}
const skippedReason = (r: ReturnType<typeof run>, rule: string) => r.report.skipped.find((s) => s.rule === rule)?.reason

describe('Foresight over a robot snapshot', () => {
  it('a healthy robot: all five checks run, nothing found, the four checklist lines OK', () => {
    const r = run(robot())
    expect(r.used).toBe(true)
    expect(r.report.findings).toEqual([])
    expect(r.report.skipped).toEqual([])
    const marked = markOnchecks({ verdict: verdictFor(r.report), report: r.report, snapshotUsed: true })
    const lines = ['CANcoder offsets correct and unchanged', 'Swerve ratio unchanged', 'All CAN devices licensed and ID\'d', 'Current limits as the code sets them']
    expect(lines.map((l) => marked.find((m) => m.line === l)!.state)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('no snapshot, or one Foresight can\'t place in this run of the robot code: every check "not checked", saying why', () => {
    const none = run(null)
    expect(none.used).toBe(false)
    expect(none.report.skipped.map((s) => s.rule)).toEqual(SNAPSHOT_RULES)
    expect(skippedReason(none, 'snapshot/devices')).toMatch(/no robot snapshot: run python3 tools\/robot-snapshot.py/)
    expect(skippedReason(run(robot(), new Date(CODE_START - 60_000).toISOString()), 'snapshot/licensed')).toMatch(/before the robot code last started/)
    expect(skippedReason(run(robot(), new Date(CODE_START + 10_000).toISOString()), 'snapshot/licensed')).toMatch(/in the first 30 s/)
    expect(skippedReason(run(robot(), AFTER_SETTLE, null), 'snapshot/licensed')).toMatch(/can't tell when the robot code started/)
    // No metadata: the "start" is only when Foresight connected, so say that rather than "before the code started".
    const early = { snapshot: makeDevicesSnapshot(robot(), new Date(CODE_START - 60_000).toISOString()), codeStartWallMs: CODE_START, codeStartFrom: 'first value' as const }
    const report: Report = { findings: [], skipped: [], crashed: [] }
    addSnapshotChecks(report, early, offseason2026, SETTLE_SECONDS)
    expect(report.skipped[0].reason).toMatch(/^the robot sent no start-up metadata/)
    expect(skippedReason(run(robot(), 'yesterday'), 'snapshot/licensed')).toMatch(/no readable time/)
    // Another robot: none of the profile's motor IDs on the bus.
    expect(skippedReason(run([{ model: 'Talon FX vers. C', id: 40, configs: {} }]), 'snapshot/devices')).toMatch(/another robot/)
    const marked = markOnchecks({ verdict: verdictFor(none.report), report: none.report, snapshotUsed: false })
    expect(marked.find((m) => m.line === 'Swerve ratio unchanged')).toMatchObject({ state: 'not checked', detail: expect.stringMatching(/no robot snapshot/) })
  })

  it('ID\'d: a missing CANcoder, a duplicate ID and an unlisted motor are amber; an unlisted CANdle is context', () => {
    const r = run(robot((d) => {
      const out = d.filter((x) => !(x.model.startsWith('CANCoder') && x.id === 2))
      device(out, 'Talon FX', 15).count = 2
      out.push({ model: 'Talon FX vers. C', id: 40, configs: {} }, { model: 'CANdle', id: 1 })
      return out
    }))
    expect(r.titles).toEqual(expect.arrayContaining([
      'Back Left CANcoder (CANcoder 2) is not on the CAN bus',
      'Flywheel leader (Talon FX 15): its CAN ID is used more than once',
      'Talon FX 40 on the canivore1 is not in the robot profile',
      '1 other CTRE device on the bus that the profile doesn\'t list',
    ]))
    expect(r.report.findings.find((f) => f.title.startsWith('1 other'))!.severity).toBe('info')
    expect(r.report.findings.find((f) => f.title.startsWith('Talon FX 40'))!.key).toBe('snapshot/devices:Talon FX 40 on the canivore1')
    // The missing CANcoder's offset couldn't be checked: partly, not clean.
    expect(skippedReason(r, 'snapshot/cancoder-offsets')).toMatch(/^partly checked; Back Left CANcoder: not on the bus/)
  })

  it('licensed: a fused steer motor without a Pro licence is amber, sticky said as such; unreadable licence faults are "partly"', () => {
    const r = run(robot((d) => {
      device(d, 'Talon FX', 3).selfTest = { ...TALON_LICENCE, StickyFault_TALONFX_UsingFusedCCWhileUnlicensed: true }
      device(d, 'Talon FX', 5).selfTest = { ...TALON_LICENCE, Fault_TALONFX_UsingFusedCCWhileUnlicensed: true }
      device(d, 'Pigeon', 0).selfTest = {}
    }))
    expect(r.rules).toEqual(['snapshot/licensed', 'snapshot/licensed'])
    expect(r.titles).toEqual([
      'Front Right steer used a Pro feature without a licence (a sticky fault: since faults were last cleared)',
      'Back Left steer is using a Pro feature without a licence',
    ])
    expect(r.report.findings[0].evidence.faults).toBe('StickyFault_TALONFX_UsingFusedCCWhileUnlicensed')
    expect(skippedReason(r, 'snapshot/licensed')).toMatch(/^partly checked; no licence faults read from Gyro \(Pigeon\) \(fault names as in Phoenix 26.3.0/)
  })

  it('licensed: a device the profile doesn\'t list (a CANdle with no self-test) is not checked for licences; no fault rows anywhere is "not checked"', () => {
    const r = run(robot((d) => { d.push({ model: 'CANdle', id: 1 }) }))
    expect(skippedReason(r, 'snapshot/licensed')).toBeUndefined()
    const blind = run(robot((d) => { for (const x of d) x.selfTest = {} }))
    expect(skippedReason(blind, 'snapshot/licensed')).toMatch(/^no licence faults read from any of the 25 devices/)
  })

  it('a line is never OK while one of its snapshot checks read only part of what it needs', () => {
    const line = (r: ReturnType<typeof run>, name: string) => markOnchecks({ verdict: verdictFor(r.report), report: r.report, snapshotUsed: true }).find((m) => m.line === name)!
    // IDs all fine, licence faults read nowhere: "licensed and ID'd" is not checked, not OK.
    const blind = run(robot((d) => { for (const x of d) x.selfTest = {} }))
    expect(line(blind, 'All CAN devices licensed and ID\'d')).toMatchObject({ state: 'not checked', detail: expect.stringMatching(/^snapshot\/licensed: no licence faults read/) })
    // Every offset unread, every remote sensor ID read: the offsets line is not checked.
    const offsets = run(robot((d) => { for (const x of d) if (x.model.startsWith('CANCoder')) x.configs = {} }))
    expect(line(offsets, 'CANcoder offsets correct and unchanged')).toMatchObject({ state: 'not checked', detail: expect.stringMatching(/^snapshot\/cancoder-offsets: partly checked; Front Left CANcoder: its magnet offset wasn't read/) })
  })

  it('CANcoder offsets: a quarter turn off fires; a whole turn or a rounding difference doesn\'t; a steer motor reading another CANcoder fires', () => {
    const offset = (d: FakeDevice[], id: number) => device(d, 'CANCoder', id).configs!
    const r = run(robot((d) => {
      offset(d, 0).CANCoder_MagnetOffset = expected.devices[0].magnetOffset! + 0.25
      offset(d, 1).CANCoder_MagnetOffset = expected.devices[1].magnetOffset! + 1
      offset(d, 2).CANCoder_MagnetOffset = expected.devices[2].magnetOffset! + OFFSET_TOLERANCE / 2
      device(d, 'Talon FX', 7).configs!.Config_FeedbackRemoteSensorID = 2
    }))
    expect(r.rules).toEqual(['snapshot/cancoder-offsets', 'snapshot/cancoder-offsets'])
    expect(r.titles[0]).toMatch(/^Front Left CANcoder's offset is 0\.4124 rotations, not the code's 0\.1624 \(90° off\)/)
    expect(r.titles[1]).toBe('Talon FX 7 reads CANcoder 2, not Back Right CANcoder (3)')
    expect(r.report.findings[0].evidence['set in the code']).toBe('DumperSwerveConstants.java:127')
  })

  it('CANcoder offsets: the simulator fixture\'s spelling (Config_MagnetOffset) reads too; an offset not read is not OK', () => {
    const r = run(robot((d) => {
      const fl = device(d, 'CANCoder', 0)
      fl.configs = { Config_MagnetOffset: fl.configs!.CANCoder_MagnetOffset as number }
      device(d, 'CANCoder', 4).configs = {}
    }))
    expect(r.rules).toEqual([])
    expect(skippedReason(r, 'snapshot/cancoder-offsets')).toBe('partly checked; Intake CANcoder: its magnet offset wasn\'t read')
  })

  it('swerve ratio: R1 gearing on every drive motor is one amber finding naming all four; a steer ratio unread is "partly"', () => {
    const r1 = 7.03 / (2 * Math.PI * 0.0508)
    const r = run(robot((d) => {
      for (const id of [0, 2, 4, 6]) device(d, 'Talon FX', id).configs!.Config_SensorToMechanismRatio = r1
      delete device(d, 'Talon FX', 1).configs!.Config_RotorToSensorRatio
    }))
    expect(r.rules).toEqual(['snapshot/swerve-ratio'])
    expect(r.titles[0]).toBe('Drive: 4 motors run another ratio than the code\'s (sensor-to-mechanism 18.8918)')
    expect(r.report.findings[0].evidence.applied).toMatch(/^Front Left drive: sensor-to-mechanism 22.0248; /)
    expect(skippedReason(r, 'snapshot/swerve-ratio')).toBe('partly checked; Front Left steer: its rotor-to-sensor ratio wasn\'t read')
  })

  it('a CANcoder read by a motor but with no offset in the profile still has its reader checked', () => {
    const profile = structuredClone(offseason2026)
    delete profile.foresight!.snapshot!.devices[0].magnetOffset
    const report: Report = { findings: [], skipped: [], crashed: [] }
    addSnapshotChecks(report, { snapshot: makeDevicesSnapshot(robot((d) => { device(d, 'Talon FX', 1).configs!.Config_FeedbackRemoteSensorID = 3 }), AFTER_SETTLE), codeStartWallMs: CODE_START }, profile, SETTLE_SECONDS)
    expect(report.findings.map((f) => f.title)).toEqual(['Talon FX 1 reads CANcoder 3, not Front Left CANcoder (0)'])
  })

  it('the CalGames profile points at the intake CANcoder\'s lines in its own code (d339f29)', () => {
    expect(offseason2026Event.foresight!.snapshot!.devices.find((d) => d.name === 'Intake CANcoder')!.where).toMatch(/SlapdownSubsystem.java:329/)
    expect(offseason2026Event.foresight!.snapshot!.devices.filter((d) => d.name !== 'Intake CANcoder')).toEqual(expected.devices.filter((d) => d.name !== 'Intake CANcoder'))
  })

  it('a wheel radius 1 % off is a different ratio; a rounding difference is not', () => {
    const drive = expected.ratios.find((x) => x.group === 'Drive')!.sensorToMechanism!
    const one = (value: number) => run(robot((d) => { device(d, 'Talon FX', 0).configs!.Config_SensorToMechanismRatio = value })).rules
    expect(one(drive * 1.01)).toEqual(['snapshot/swerve-ratio'])
    expect(one(drive * 1.0005)).toEqual([])
  })

  it('current limits: a follower at 60 A supply is amber, with the code\'s value and where it is set', () => {
    const r = run(robot((d) => { device(d, 'Talon FX', 16).configs!.Config_SupplyCurrentLimit = 60 }))
    expect(r.rules).toEqual(['snapshot/current-limits'])
    expect(r.titles[0]).toBe('Flywheel: Flywheel follower 16 runs other current limits than the code sets')
    expect(r.report.findings[0].evidence.differs).toMatch(/supply limit 60 A \(code: \d+ A\)/)
  })

  it('a device the collector didn\'t read is "partly checked", never clean', () => {
    const r = run(robot((d) => { const fl = device(d, 'Talon FX', 0); Object.assign(fl, { configs: undefined, selfTest: undefined, skipped: 'timed out' }) }))
    expect(skippedReason(r, 'snapshot/licensed')).toMatch(/^partly checked; no licence faults read from Front Left drive \(not read: timed out\)/)
    expect(skippedReason(r, 'snapshot/current-limits')).toMatch(/Front Left drive: its configs weren't read/)
  })

  it('every snapshot check stays amber, even when the proof table would make it red', () => {
    const r = run(robot((d) => { device(d, 'Talon FX', 16).configs!.Config_SupplyCurrentLimit = 60 }))
    const proven = Object.fromEntries(SNAPSHOT_RULES.map((rule) => [rule, { logs: 9, fires: 1, ourFires: 1, base: 'x', date: 'd' }]))
    const verdict = verdictFor(r.report, proven, Object.fromEntries(SNAPSHOT_RULES.map((rule) => [rule, SNAPSHOT_PROOF])))
    expect(verdict.items.map((i) => [i.level, i.proof])).toEqual([['amber', SNAPSHOT_PROOF]])
    expect(verdict.verdict).toBe('GO')
  })

  it('read-only: no Foresight or snapshot source names a diagnostic-server action that writes, blinks or clears', () => {
    const dirs = ['src/foresight', 'src/snapshot', 'src/ui']
    const sources = dirs.flatMap((dir) => readdirSync(dir).map((f) => readFileSync(`${dir}/${f}`, 'utf8')))
    for (const action of ['blink', 'controlv2', 'setconfigv2', 'setid', 'setname', 'clearstickyfaults']) {
      expect(sources.some((s) => new RegExp(`action=${action}\\b|['"]${action}['"]`, 'i').test(s))).toBe(false)
    }
  })
})
