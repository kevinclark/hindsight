// Foresight's checks on made-up robots (a "badness" log each), run through the real engine, plus the proof that
// the keys Foresight subscribes to are enough: on the CalGames logs, the subscribed keys give the same findings as
// the whole log.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { openWpilog, readNumbers, readRaw } from '../src/readers/wpilog.ts'
import { RecordStore } from '../src/foresight/records.ts'
import { evaluateForesight, SETTLE_SECONDS, type ForesightResult } from '../src/foresight/engine.ts'
import { foresightKeys, foresightKeysIn, LOG_DRIVE_KEYS, RECENT_SECONDS } from '../src/foresight/keys.ts'
import { PROVEN } from '../src/foresight/proven.ts'
import { FORESIGHT_RULES } from '../src/rules/index.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import { markOnchecks } from '../src/foresight/onchecks.ts'
import { KEEP_SECONDS } from '../src/foresight/records.ts'
import { photonTargetCount } from '../src/readers/photon.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { CALGAMES, haveCalGames } from './helpers/load.ts'
import { makeDevicesSnapshot, profileSnapshot } from './helpers/make-snapshot.ts'
import { sameModel, snapshotBusFor, snapshotDeviceFor, type SnapshotInput } from '../src/foresight/snapshot-checks.ts'

const START = 10
const NOW = 100
const steady = (value: number | boolean | string) => [[START, value]] as [number, number | boolean | string][]
/** A reading that changes every loop, like a motor's stator current at rest. */
const jitter = (from = START, to = NOW): [number, number][] => {
  const out: [number, number][] = []
  for (let t = from, i = 0; t <= to; t += 0.02, i++) out.push([t, i % 2 ? 0.1 : 0.2])
  return out
}
/** A PhotonVision result with no targets (sequence id 1), or with n targets (empty target messages). */
const photonResult = (n = 0) => new Uint8Array([0x20, 0x01, ...Array.from({ length: n }, () => [0x12, 0x00]).flat()])
const RESULT_TYPE = 'proto:photonvision.proto.ProtobufPhotonPipelineResult'
const motors = offseason2026.motorGroups.flatMap((g) => g.motors)

/** A healthy robot sitting disabled in the pit, tethered, from START to NOW. */
function healthy(): FixtureEntry[] {
  const clock: [number, number][] = []
  for (let t = START; t <= NOW; t += 0.5) clock.push([t, Math.round(t * 1e6)])
  return [
    { name: '/Timestamp', type: 'int64', records: clock },
    { name: '/RealMetadata/GitSHA', type: 'string', records: steady('123eec6268b7956526d03c7971a03b6fd8e29b2c') },
    { name: '/RealMetadata/GitDirty', type: 'string', records: steady('All changes committed') },
    { name: '/DriverStation/Enabled', type: 'boolean', records: steady(false) },
    { name: '/DriverStation/DSAttached', type: 'boolean', records: steady(true) },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: steady(false) },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: steady(12.7) },
    { name: '/RealOutputs/Alerts/errors', type: 'string[]', records: [[START, []]] },
    { name: '/DriverStation/Joystick0/Name', type: 'string', records: steady('Controller (Xbox One For Windows)') },
    { name: '/DriverStation/Joystick1/Name', type: 'string', records: steady('Controller (Xbox One For Windows)') },
    { name: '/Swerve/Gyro/Yaw', type: 'struct:Rotation2d', records: steady(1.5) },
    { name: '/Intake/CANcoder/CancoderPositionRotations', type: 'struct:Rotation2d', records: steady(0.6536 * 2 * Math.PI) },
    { name: '/Intake/Pivot/PositionRotations', type: 'double', records: steady(0.3677) },
    // Every device and camera the profile names is connected (so the profile fits); cameras stale while disabled.
    ...[...offseason2026.motorGroups.flatMap((g) => g.motors.map((m) => m.connected!)), ...offseason2026.otherDevices.map((d) => d.connected), ...offseason2026.cameras.map((c) => c.connected)]
      .map((name) => ({ name, type: 'boolean', records: steady(true) })),
    ...offseason2026.cameras.map((c) => ({ name: c.stale, type: 'boolean', records: steady(true) })),
    // Cool motors, readings that change at rest, cameras that see no tag (the pit).
    ...motors.map((m) => ({ name: m.temperature!, type: 'double', records: steady(30) })),
    ...[...motors.map((m) => m.updating), ...offseason2026.otherDevices.map((d) => d.updating)].filter((k): k is string => !!k)
      .map((name) => ({ name, type: 'double', records: jitter() })),
    ...offseason2026.cameras.map((c) => ({ name: c.result!, type: RESULT_TYPE, records: jitter().map(([t]) => [t, photonResult()] as [number, Uint8Array]) })),
  ]
}

/** The healthy robot with some entries replaced. */
function robot(changes: FixtureEntry[]): Uint8Array {
  const byName = new Map<string, FixtureEntry>()
  for (const e of [...healthy(), ...changes]) byName.set(e.name, e)
  return writeWpilog([...byName.values()])
}

function check(changes: FixtureEntry[], lastPassingSha: string | null = null, snapshot?: SnapshotInput): Extract<ForesightResult, { state: 'checked' }> {
  const store = RecordStore.fromWpilog(openWpilog(robot(changes)), null)
  const r = evaluateForesight({ store, codeStart: START, now: NOW, lastPassingSha, profile: offseason2026, snapshot })
  if (r.state !== 'checked') throw new Error(`not checked: ${r.state}`)
  return r
}
const rules = (r: ReturnType<typeof check>, level?: string) => r.verdict.items.filter((i) => !level || i.level === level).map((i) => i.finding.rule)
/** Amber or red: what moves the pit crew. */
const flagged = (r: ReturnType<typeof check>) => r.verdict.items.filter((i) => i.level !== 'grey').map((i) => i.finding.rule)

describe('Foresight checks on a robot in the pit', () => {
  it('a healthy robot: GO, nothing flagged; grey: hold a tag up to each camera, and gyro drift', () => {
    const r = check([])
    expect(r.verdict.verdict).toBe('GO')
    expect(flagged(r)).toEqual([])
    expect(rules(r, 'grey')).toEqual(['foresight/camera-sees-tag', 'foresight/camera-sees-tag', 'foresight/gyro-still-drift'])
    expect(r.verdict.items.filter((i) => i.finding.rule === 'foresight/camera-sees-tag').map((i) => i.finding.title)).toEqual(['Hold an AprilTag up to Back_Left', 'Hold an AprilTag up to Back_Right'])
    // Values-updating ran on all 16 readings, and says which devices it can't judge.
    expect(r.report.skipped.find((s) => s.rule === 'foresight/values-updating')?.reason).toMatch(/no reading that changes at rest for Flywheel leader, .*Intake CANcoder$/)
    expect(r.report.crashed).toEqual([])
  })

  it('says nothing before settle (a countdown) and checks only after it', () => {
    const store = RecordStore.fromWpilog(openWpilog(writeWpilog(healthy())), null)
    const r = evaluateForesight({ store, codeStart: START, now: START + SETTLE_SECONDS - 1, lastPassingSha: null, profile: offseason2026 })
    expect(r).toMatchObject({ state: 'settling' })
    expect(r.state === 'settling' && r.secondsLeft).toBeCloseTo(1)
  })

  it('a controller missing on port 1', () => {
    const r = check([{ name: '/DriverStation/Joystick1/Name', type: 'string', records: steady('') }])
    expect(flagged(r)).toEqual(['foresight/controllers'])
    expect(r.verdict.items[0].finding.title).toMatch(/port 1 /)
    // Clean on the backtest but never fired on our logs: amber (Kevin, 2026-10-19), so GO with one to look at.
    expect(r.verdict.items[0].level).toBe('amber')
    expect(r.verdict.verdict).toBe('GO')
    expect(r.verdict.items[0].proof).toMatch(/^amber until it catches a real fault on one of our logs \(no false reds on 3 match logs/)
  })

  it('controllers not checked while the Driver Station is not connected', () => {
    const r = check([{ name: '/DriverStation/DSAttached', type: 'boolean', records: steady(false) }])
    expect(r.report.skipped.find((s) => s.rule === 'foresight/controllers')?.reason).toMatch(/Driver Station is not connected/)
  })

  it('the intake pivot seeded in encoder rotations, not mechanism rotations (≈100° off)', () => {
    const r = check([{ name: '/Intake/Pivot/PositionRotations', type: 'double', records: steady(0.6536) }])
    expect(flagged(r)).toEqual(['foresight/zero-sanity'])
    expect(r.verdict.items[0].finding.measured?.[0].value).toBeGreaterThan(90)
    expect(r.report.skipped.find((s) => s.rule === 'foresight/zero-sanity')?.reason).toMatch(/Hood not checked/)
  })

  it('a zero within 2° is fine', () => {
    const r = check([{ name: '/Intake/Pivot/PositionRotations', type: 'double', records: steady(0.3677 + 1.5 / 360) }])
    expect(flagged(r)).toEqual([])
  })

  it('a device that drops off CAN while disabled', () => {
    const r = check([{ name: '/Intake/CANcoder/Connected', type: 'boolean', records: [[START, true], [70, false], [71, true]] }])
    expect(rules(r)).toContain('can/device-dropout')
  })

  it('a camera that drops out while disabled; a stale camera alone is not a finding', () => {
    const r = check([{ name: '/Apriltag VisionBack_Left/Connected', type: 'boolean', records: [[START, true], [60, false], [66, true]] }])
    expect(rules(r)).toContain('vision/stale')
    expect(r.verdict.items.find((i) => i.finding.rule === 'vision/stale')!.finding.title).toMatch(/dropped out 1 time since start-up settled/)
  })

  it('a robot alert still on after settle, but not one that cleared before it', () => {
    const alerts = { name: '/RealOutputs/Alerts/errors', type: 'string[]', records: [[START, ['Back_Left Camera Disconnected!']], [START + 15, []], [80, ['Intake CANcoder disconnected!']]] } as FixtureEntry
    const r = check([alerts])
    const titles = r.verdict.items.filter((i) => i.finding.rule === 'alerts/passthrough').map((i) => i.finding.title)
    expect(titles).toEqual(['Alert "Intake CANcoder disconnected!" 1× since start-up settled'])
  })

  it('time-sync in the pit: an alert in the stretch is a warning; one from before it is not in view at all', () => {
    const sync = (t: number) => ({ name: '/RealOutputs/PhotonAlerts/warnings', type: 'string[]', records: [[START, []], [t, ['Camera is not connected to the TimeSyncServer']], [t + 1, []]] }) as FixtureEntry
    const during = check([sync(80)]).verdict.items.find((i) => i.finding.rule === 'vision/time-sync')!
    expect([during.finding.severity, during.level]).toEqual(['warning', 'amber'])
    // Hindsight calls a boot-only alert info; the pit's window starts after start-up, so there it is simply not in view.
    expect(check([sync(START + 5)]).verdict.items.find((i) => i.finding.rule === 'vision/time-sync')).toBeUndefined()
  })

  it('rest voltage is the last 2 s; uncommitted code; code changed since the last passing check', () => {
    const r = check([
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[START, 12.7], [95, 12.3]] },
      { name: '/RealMetadata/GitDirty', type: 'string', records: steady('Uncommitted changes') },
    ], 'fb5f9b7f5d5e37af18d560948055f297bac53f7a')
    expect(flagged(r).sort()).toEqual(['build/dirty', 'foresight/commit-matches', 'power/rest-voltage'])
    expect(rules(r, 'amber')).toEqual(['foresight/commit-matches']) // never judged on a log yet: stays amber
  })

  it('enabled now: no verdict; after a disable it waits 10 s, then checks from there', () => {
    const store = RecordStore.fromWpilog(openWpilog(robot([{ name: '/DriverStation/Enabled', type: 'boolean', records: [[START, false], [90, true]] }])), null)
    expect(evaluateForesight({ store, codeStart: START, now: NOW, lastPassingSha: null, profile: offseason2026 }).state).toBe('enabled')
    const r = check([{ name: '/DriverStation/Enabled', type: 'boolean', records: [[START, false], [60, true], [70, false]] }])
    expect(r.start).toBe(80)
  })

  it('an enable that ended just before settle still gets its recovery wait', () => {
    const r = check([{ name: '/DriverStation/Enabled', type: 'boolean', records: [[START, false], [30, true], [38, false]] }])
    expect(r.start).toBe(48)
  })

  it('after a drive, low rest voltage stays amber (the backtest only proved it before any enable)', () => {
    const r = check([
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[START, false], [60, true], [70, false]] },
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[START, 12.7], [60, 11], [70, 12.2]] },
    ])
    const item = r.verdict.items.find((i) => i.finding.rule === 'power/rest-voltage')!
    expect(item.level).toBe('amber')
    expect(item.proof).toMatch(/driven 30 s ago/)
    const before = check([{ name: '/SystemStats/BatteryVoltage', type: 'double', records: [[START, 12.2]] }])
    expect(before.verdict.items.find((i) => i.finding.rule === 'power/rest-voltage')!.level).toBe('red')
  })

  it('a device already off when the stretch starts: no claim about the battery it has no data for', () => {
    const r = check([{ name: '/Intake/CANcoder/Connected', type: 'boolean', records: steady(false) }])
    const f = r.verdict.items.find((i) => i.finding.rule === 'can/device-dropout')!.finding
    expect(f.title).toMatch(/first already off when the check started/)
    expect(f.time).toBe(r.start)
    expect(f.evidence['lowest battery voltage in the 0.5 s before each drop (V)']).toBe('already off when the check started')
    expect(f.causes.find((c) => c.id === 'battery-sag')?.ruledOut).toBeUndefined()
  })

  it('a motor above 60 °C before the match is amber; 60 °C is not', () => {
    const r = check([{ name: '/Swerve/Back Left Module/DriveTempC', type: 'double', records: [[START, 30], [80, 65]] }])
    expect(flagged(r)).toEqual(['foresight/motor-temperature'])
    const item = r.verdict.items.find((i) => i.finding.rule === 'foresight/motor-temperature')!
    expect(item.level).toBe('amber')
    expect(item.finding.title).toBe('Back Left drive is at 65 °C with the robot disabled (above 60 °C)')
    expect(r.verdict.verdict).toBe('GO')
    expect(flagged(check([{ name: '/Drum/Flywheel/Leader/TempC', type: 'double', records: steady(60) }]))).toEqual([])
  })

  it('a reading frozen for 5 s while the others change; not while the device is off CAN', () => {
    const frozen = { name: '/Intake/Pivot/StatorCurrentAmps', type: 'double', records: jitter(START, 94) } as FixtureEntry
    const r = check([frozen])
    expect(flagged(r)).toEqual(['foresight/values-updating'])
    expect(r.verdict.items[0].finding.title).toBe('Intake pivot: its readings have not changed for 5 s while 15 other device readings did')
    expect(r.verdict.items[0].level).toBe('amber')
    // Frozen 4 s only: fine.
    expect(flagged(check([{ ...frozen, records: jitter(START, 96.5) }]))).toEqual([])
    // Off CAN: device-dropout says it, not this.
    const off = check([frozen, { name: '/Intake/Pivot/Connected', type: 'boolean', records: [[START, true], [94, false]] }])
    expect(flagged(off)).toEqual(['can/device-dropout'])
  })

  it('every reading frozen while the robot still sends: one amber for the whole robot, and the line says so', () => {
    const still = [...motors.map((m) => m.updating), '/Swerve/Gyro/YawVelocityRadPerSec'].filter((k): k is string => !!k)
      .map((name) => ({ name, type: 'double', records: jitter(START, 90) }))
    const r = check(still)
    expect(flagged(r)).toEqual(['foresight/values-updating'])
    expect(r.verdict.items[0].finding.title).toBe('No device reading changed in the last 5 s (16 watched): the robot may have stopped reading its devices')
    expect(r.verdict.items[0].proof).toMatch(/no false reds on 3 match logs/)
    expect(markOnchecks(r).find((l) => l.line === 'All device values updating')!.state).toBe('amber')
  })

  it('a reading the robot does not send (or announced with no value) is skipped for that device only', () => {
    const r = check([{ name: '/Intake/Pivot/StatorCurrentAmps', type: 'double', records: [] }])
    const store = RecordStore.fromWpilog(openWpilog(robot([])), null)
    store.entries.delete('/Intake/Pivot/StatorCurrentAmps')
    const missing = evaluateForesight({ store, codeStart: START, now: NOW, lastPassingSha: null, profile: offseason2026 })
    if (missing.state !== 'checked') throw new Error(missing.state)
    expect(missing.report.skipped.find((s) => s.rule === 'foresight/values-updating')?.reason).toMatch(/^partly checked; .*Intake pivot: the robot does not send \/Intake\/Pivot\/StatorCurrentAmps/)
    // Announced but no value yet: skipped the same way, not "frozen".
    expect(flagged(r)).toEqual([])
    expect(r.report.skipped.find((s) => s.rule === 'foresight/values-updating')?.reason).toMatch(/Intake pivot: the robot does not send/)
  })

  it('a camera passes once it sees a tag during the check (one is enough), or once it makes a pose', () => {
    const left = { name: '/Apriltag VisionBack_Left/Result', type: RESULT_TYPE, records: [[START, photonResult()], [70, photonResult(1)], [70.02, photonResult()]] } as FixtureEntry
    const r = check([left])
    expect(r.verdict.items.filter((i) => i.finding.rule === 'foresight/camera-sees-tag').map((i) => i.finding.title)).toEqual(['Hold an AprilTag up to Back_Right'])
    const line = markOnchecks(r).find((l) => l.line === 'All cameras on and detecting AprilTags')!
    expect([line.state, line.detail]).toEqual(['to do', 'Hold an AprilTag up to Back_Right'])
    const pose = { name: '/RealOutputs/Vision/Back_Right/Pose2d', type: 'struct:Pose2d', records: [[80, { x: 1, y: 2, rot: 0 }]] } as FixtureEntry
    const both = check([left, pose])
    expect(rules(both, 'grey')).toEqual(['foresight/gyro-still-drift'])
    expect(markOnchecks(both).find((l) => l.line === 'All cameras on and detecting AprilTags')!.state).toBe('ok')
  })

  it('one camera unread: the cameras line is not checked, even when the other camera saw a tag', () => {
    const store = RecordStore.fromWpilog(openWpilog(robot([{ name: '/Apriltag VisionBack_Left/Result', type: RESULT_TYPE, records: [[START, photonResult()], [70, photonResult(1)]] }])), null)
    store.entries.delete('/Apriltag VisionBack_Right/Result')
    const r = evaluateForesight({ store, codeStart: START, now: NOW, lastPassingSha: null, profile: offseason2026 })
    if (r.state !== 'checked') throw new Error(r.state)
    const line = markOnchecks(r).find((l) => l.line === 'All cameras on and detecting AprilTags')!
    expect(line.state).toBe('not checked')
    expect(line.detail).toMatch(/Back_Right sends neither its camera result nor a pose/)
  })

  it('with only poses to go on, the step asks for two tags', () => {
    // A pose from before the check started: the topic exists, but nothing during the check.
    const store = RecordStore.fromWpilog(openWpilog(robot([{ name: '/RealOutputs/Vision/Back_Left/Pose2d', type: 'struct:Pose2d', records: [[START + 1, { x: 1, y: 2, rot: 0 }]] }])), null)
    store.entries.delete('/Apriltag VisionBack_Left/Result')
    const r = evaluateForesight({ store, codeStart: START, now: NOW, lastPassingSha: null, profile: offseason2026 })
    if (r.state !== 'checked') throw new Error(r.state)
    expect(r.verdict.items.filter((i) => i.finding.rule === 'foresight/camera-sees-tag').map((i) => i.finding.title)).toEqual(['Hold two AprilTags up to Back_Left (it reports only poses)', 'Hold an AprilTag up to Back_Right'])
  })

  it('a tag seen only before the check started does not count', () => {
    const r = check([{ name: '/Apriltag VisionBack_Left/Result', type: RESULT_TYPE, records: [[START, photonResult()], [20, photonResult(2)]] }])
    expect(r.verdict.items.filter((i) => i.finding.rule === 'foresight/camera-sees-tag').length).toBe(2)
  })

  it('after 15 min the oldest records are dropped: the stretch starts there and counts say "in the last 15 min"', () => {
    const late = START + KEEP_SECONDS + 200
    const store = RecordStore.fromWpilog(openWpilog(robot([
      { name: '/Timestamp', type: 'int64', records: [[START, START * 1e6], [late, late * 1e6]] },
      { name: '/Apriltag VisionBack_Left/Connected', type: 'boolean', records: [[START, true], [late - 100, false], [late - 95, true]] },
    ])), null)
    store.prune()
    const r = evaluateForesight({ store, codeStart: START, now: late, lastPassingSha: null, profile: offseason2026 })
    if (r.state !== 'checked') throw new Error(r.state)
    expect(r.start).toBeCloseTo(late - KEEP_SECONDS)
    expect(r.verdict.items.find((i) => i.finding.rule === 'vision/stale')!.finding.title).toMatch(/dropped out 1 time in the last 15 min/)
  })

  it('zero sanity waits while the mechanism is being moved', () => {
    const r = check([{ name: '/Intake/Pivot/PositionRotations', type: 'double', records: [[START, 0.3677], [99, 0.3677 + 5 / 360], [99.5, 0.6536]] }])
    expect(flagged(r)).toEqual([])
    expect(r.report.skipped.find((s) => s.rule === 'foresight/zero-sanity')?.reason).toMatch(/Intake pivot not checked: it is moving/)
  })
})

describe('Foresight: the log USB stick, from the companion library\'s log-drive reading', () => {
  const drive = (onUsb: boolean, status = 'ok', path = '/U', device = '/dev/sda1'): FixtureEntry[] => [
    { name: LOG_DRIVE_KEYS.onUsb, type: 'boolean', records: steady(onUsb) },
    { name: LOG_DRIVE_KEYS.status, type: 'string', records: steady(status) },
    { name: LOG_DRIVE_KEYS.path, type: 'string', records: steady(path) },
    { name: LOG_DRIVE_KEYS.device, type: 'string', records: steady(device) },
  ]
  const line = (r: ReturnType<typeof check>) => markOnchecks(r).find((l) => l.line === 'Log stick in')!

  it('Foresight asks the robot for the companion\'s log-drive keys (tests/companion-keys.test.ts checks them against its list)', () => {
    expect(foresightKeys(offseason2026)).toEqual(expect.arrayContaining(Object.values(LOG_DRIVE_KEYS)))
  })

  it('a robot without the companion: not checked, with why; never OK, and the verdict is untouched', () => {
    const r = check([])
    expect(r.report.skipped.find((s) => s.rule === 'foresight/log-usb-stick')?.reason).toMatch(/doesn't send \/Hindsight\/LogDrive\/OnUsb/)
    expect(line(r)).toMatchObject({ state: 'not checked' })
    expect(line(r).detail).toBe("the robot doesn't send /Hindsight/LogDrive/OnUsb: check by hand")
    expect(r.verdict.verdict).toBe('GO')
    expect(r.verdict.reason).toBe('nothing found')
  })

  it('the log on the stick: OK, saying it is the reading from code start', () => {
    const r = check(drive(true))
    expect(r.report.skipped.map((s) => s.rule)).not.toContain('foresight/log-usb-stick')
    expect(line(r)).toMatchObject({ state: 'ok' })
    expect(line(r).detail).toMatch(/when its code started.*Restart the robot code/)
  })

  it('the log not on a stick: amber (never red: no log of ours has it), GO with one to look at', () => {
    const r = check(drive(false, 'ok', '/U', '/dev/mmcblk0p1'))
    const item = r.verdict.items.find((i) => i.finding.rule === 'foresight/log-usb-stick')!
    expect(item.level).toBe('amber')
    expect(item.finding.title).toBe('The robot log (/U) is not on a USB stick: it is on /dev/mmcblk0p1')
    expect(PROVEN['foresight/log-usb-stick']).toBeUndefined()
    expect(r.verdict.verdict).toBe('GO')
    expect(line(r)).toMatchObject({ state: 'amber' })
  })

  it('OnUsb alone (no status, path or device): OK when on the stick; amber with no path or device when not', () => {
    const only = (onUsb: boolean): FixtureEntry[] => [{ name: LOG_DRIVE_KEYS.onUsb, type: 'boolean', records: steady(onUsb) }]
    expect(line(check(only(true)))).toMatchObject({ state: 'ok' })
    const item = check(only(false)).verdict.items.find((i) => i.finding.rule === 'foresight/log-usb-stick')!
    expect(item).toMatchObject({ level: 'amber' })
    expect(item.finding.title).toBe('The robot log is not on a USB stick')
    expect(item.finding.evidence).toEqual({})
  })

  it('a reading the robot could not take (simulation, a failed read): not checked, with its status', () => {
    const r = check(drive(false, 'not read'))
    expect(r.report.skipped.find((s) => s.rule === 'foresight/log-usb-stick')?.reason).toMatch(/could not read where its log goes \(not read\)/)
    expect(r.verdict.items.map((i) => i.finding.rule)).not.toContain('foresight/log-usb-stick')
    expect(line(r)).toMatchObject({ state: 'not checked' })
  })

  it('is a Foresight check', () => {
    expect(FORESIGHT_RULES.map((rule) => rule.id)).toContain('foresight/log-usb-stick')
  })
})

describe('Foresight with a robot snapshot dropped on the page', () => {
  const codeStartWallMs = Date.parse('2026-10-20T17:00:00Z')
  const taken = new Date(codeStartWallMs + (SETTLE_SECONDS + 20) * 1000).toISOString()
  const SNAPSHOT_LINES = ['CANcoder offsets correct and unchanged', 'Swerve ratio unchanged', 'All CAN devices licensed and ID\'d', 'Current limits as the code sets them']
  const lines = (r: ReturnType<typeof check>) => SNAPSHOT_LINES.map((l) => markOnchecks(r).find((m) => m.line === l)!.state)

  it('a healthy robot and a healthy snapshot from this run: GO, and the snapshot lines OK', () => {
    const r = check([], null, { snapshot: makeDevicesSnapshot(profileSnapshot(offseason2026), taken), codeStartWallMs })
    expect(r.snapshotUsed).toBe(true)
    expect(r.verdict.verdict).toBe('GO')
    expect(flagged(r)).toEqual([])
    expect(lines(r)).toEqual(['ok', 'ok', 'ok', 'ok'])
  })

  it('no snapshot: still GO (the snapshot checks can\'t go red), the snapshot lines "not checked"', () => {
    const r = check([])
    expect(r.snapshotUsed).toBe(false)
    expect(r.verdict.verdict).toBe('GO')
    expect(lines(r)).toEqual(Array(4).fill('not checked'))
  })

  it('a snapshot fault is amber with the snapshot proof, and its line says "Look"', () => {
    const devices = profileSnapshot(offseason2026)
    devices.find((d) => d.model.startsWith('CANCoder') && d.id === 1)!.configs!.CANCoder_MagnetOffset = 0.3
    const r = check([], null, { snapshot: makeDevicesSnapshot(devices, taken), codeStartWallMs })
    expect(r.verdict.items.filter((i) => i.level !== 'grey').map((i) => [i.level, i.finding.rule, i.proof])).toEqual([['amber', 'snapshot/cancoder-offsets', expect.stringMatching(/^amber: no snapshot of our robot/)]])
    expect(lines(r)[0]).toBe('amber')
  })
})

describe('Foresight record store: fast readings kept only for their last 30 s', () => {
  it('writes and keeps only the last RECENT_SECONDS of a recent key, with its held value at the cut', () => {
    const store = RecordStore.fromWpilog(openWpilog(writeWpilog([
      { name: '/a', type: 'double', records: jitter(0, 100) },
      { name: '/b', type: 'double', records: jitter(0, 100) },
    ])), null)
    store.recent.set('/a', RECENT_SECONDS)
    const a = readNumbers(openWpilog(store.windowLog(10, 100)), '/a')!
    const b = readNumbers(openWpilog(store.windowLog(10, 100)), '/b')!
    expect(a.t[0]).toBeCloseTo(100 - RECENT_SECONDS)
    expect(b.t[0]).toBeCloseTo(10)
    store.prune()
    expect(store.entries.get('/a')!.t[0]).toBeLessThanOrEqual(100 - RECENT_SECONDS)
    expect(store.entries.get('/a')!.t[1]).toBeGreaterThan(100 - RECENT_SECONDS)
    expect(store.prunedTo).toBe(-Infinity) // a recent key's cut is not "the oldest records are gone"
  })
})

describe('Foresight verdict', () => {
  const finding = (rule: string, severity: 'error' | 'warning' | 'info') => ({ rule, severity, title: rule, time: null, matchTime: null, when: null, about: null, key: rule, evidence: {}, meaning: '', causes: [], nextStep: `do ${rule}` })
  const proven = {
    'power/rest-voltage': { logs: 3, fires: 1, ourFires: 1, base: 'CalGames 2026', date: '2026-10-19' },
    'vision/time-sync': { logs: 8, fires: 0, ourFires: 0, base: 'CalGames 2026 + others', date: '2026-10-19' },
    'build/dirty': { logs: 6, fires: 1, ourFires: 0, base: 'another team', date: '2026-10-19' },
  }
  it('amber unless proven; red only for proven checks; NO-GO on any red', () => {
    const v = verdictFor({ findings: [finding('build/dirty', 'warning'), finding('power/rest-voltage', 'warning'), finding('x', 'info')], skipped: [], crashed: [] }, proven)
    expect(v.verdict).toBe('NO-GO')
    expect(v.items.map((i) => [i.finding.rule, i.level])).toEqual([['power/rest-voltage', 'red'], ['build/dirty', 'amber'], ['x', 'grey']])
    expect(v.items[0].proof).toMatch(/proven on 3 match logs, fired on 1, all real/)
    expect(v.items[0].action).toBe('do power/rest-voltage')
  })
  it('clean backtest but no real fire on our logs stays amber, even after firing on another team\'s log', () => {
    const v = verdictFor({ findings: [finding('vision/time-sync', 'warning')], skipped: [], crashed: [] }, proven)
    expect(v.items[0].level).toBe('amber')
    expect(v.verdict).toBe('GO')
    expect(verdictFor({ findings: [], skipped: [{ rule: 'vision/time-sync', reason: 'missing x' }], crashed: [] }, proven).verdict).toBe('GO')
  })
  it('a rule severity of error is still amber until proven', () => {
    expect(verdictFor({ findings: [finding('can/device-dropout', 'error')], skipped: [], crashed: [] }, {}).items[0].level).toBe('amber')
  })
  it('NOT CHECKED when a check that can go red could not read its signal', () => {
    const v = verdictFor({ findings: [], skipped: [{ rule: 'power/rest-voltage', reason: 'missing /SystemStats/BatteryVoltage' }], crashed: [] }, proven)
    expect(v.verdict).toBe('NOT CHECKED')
    expect(verdictFor({ findings: [], skipped: [{ rule: 'power/rest-voltage', reason: 'partly checked; x' }], crashed: [] }, proven).verdict).toBe('GO')
  })
})

describe.skipIf(!haveCalGames)('the keys Foresight subscribes to are enough', () => {
  for (const path of [CALGAMES.q13, CALGAMES.q21, CALGAMES.p0]) {
    it(path.split('/').pop()!, () => {
      const log = openWpilog(new Uint8Array(readFileSync(path)))
      const en = readNumbers(log, '/DriverStation/Enabled')!
      const now = Array.from(en.t).find((_, i) => en.v[i] > 0.5)! - 0.1
      const codeStart = readNumbers(log, '/Timestamp')!.t[0]
      const summary = (store: RecordStore) => {
        const r = evaluateForesight({ store, codeStart, now, lastPassingSha: null })
        if (r.state !== 'checked') throw new Error(r.state)
        return { findings: r.report.findings.filter((f) => f.rule !== 'meta/not-checked').map((f) => `${f.rule}: ${f.title}`), skipped: r.report.skipped.map((s) => s.rule).sort() }
      }
      const subscribed = summary(RecordStore.fromWpilog(log, foresightKeysIn(log, offseason2026)))
      const whole = summary(RecordStore.fromWpilog(log, null))
      expect(subscribed).toEqual(whole)
      expect(foresightKeys(offseason2026).length).toBeLessThan(120) // 109: the robot publishes ~455
    })
  }
})

// Why foresight/camera-sees-tag reads the camera's raw result, not the accepted pose: on the CalGames logs the robot
// code logged a pose only from two or more tags, so one hand-held tag never makes one.
describe.skipIf(!haveCalGames)('CalGames logs: what a camera result and an accepted pose mean', () => {
  for (const path of [CALGAMES.q13, CALGAMES.q21, CALGAMES.p0]) {
    it(path.split('/').pop()!, () => {
      const log = openWpilog(new Uint8Array(readFileSync(path)))
      for (const camera of offseason2026.cameras) {
        const results = readRaw(log, camera.result!)!
        const counts = results.payload.map(photonTargetCount)
        expect(counts.every((n) => n !== null)).toBe(true)
        const tagsAt = new Map(results.t.map((t, i) => [t, counts[i]!]))
        const poses = readRaw(log, camera.acceptedPose)!.t
        // Every pose was logged in the same loop as a result with two or more tags...
        expect(poses.every((t) => (tagsAt.get(t) ?? 0) >= 2)).toBe(true)
        // ...and every such result logged one; no one-tag result did.
        const poseAt = new Set(poses)
        expect(results.t.filter((t, i) => counts[i]! >= 2).every((t) => poseAt.has(t))).toBe(true)
        expect(results.t.filter((t, i) => counts[i] === 1).some((t) => poseAt.has(t))).toBe(false)
        expect(counts.filter((n) => n === 1).length).toBeGreaterThan(1000)
      }
    })
  }
})

// The Hindsight companion's device readings (HindsightDevices.watch), live: sticky faults, firmware per model,
// reboots and devices not answering, joined to a robot snapshot by bus, model and ID. Synthetic, in companion/keys.json's shapes.
describe('Foresight over the companion\'s device readings', () => {
  /** A value read once a second from START to NOW, changing at each [time, value]. */
  const perSecond = (first: number | boolean, change: [number, number | boolean][] = []) => {
    const out: [number, number | boolean][] = []
    for (let t = START; t <= NOW; t++) out.push([t, [...change].reverse().find(([at]) => t >= at)?.[1] ?? first])
    return out
  }
  const device = (bus: string, model: string, id: number, r: { connected?: [number, number | boolean][]; resets?: [number, number | boolean][]; sticky?: number; version?: number } = {}): FixtureEntry[] => {
    const at = `/Hindsight/Devices/${bus}/${model}/${id}`
    return [
      { name: `${at}/Connected`, type: 'boolean', records: r.connected ?? perSecond(true) },
      { name: `${at}/Resets`, type: 'int64', records: r.resets ?? perSecond(0) },
      { name: `${at}/Version`, type: 'int64', records: steady(r.version ?? 0x1a010000) },
      { name: `${at}/FaultField`, type: 'int64', records: steady(0) },
      { name: `${at}/StickyFaultField`, type: 'int64', records: steady(r.sticky ?? 0) },
      { name: `${at}/ProLicensed`, type: 'boolean', records: steady(true) },
      { name: `${at}/Status`, type: 'string', records: steady('OK') },
    ]
  }
  const healthLine = (r: ReturnType<typeof check>) => markOnchecks(r).find((l) => l.line === 'CTRE devices healthy')!
  const item = (r: ReturnType<typeof check>, rule: string) => r.verdict.items.find((i) => i.finding.rule === rule)

  it('a robot without the companion: the checks say why, the line is "not checked", and the verdict is untouched', () => {
    const r = check([])
    for (const rule of ['can/device-rebooted', 'foresight/sticky-faults']) expect(r.report.skipped.find((s) => s.rule === rule)?.reason).toMatch(/watches no CTRE device/)
    expect(r.report.skipped.find((s) => s.rule === 'foresight/firmware-mismatch')?.reason).toMatch(/no watched device is answering/)
    expect(healthLine(r).state).toBe('not checked')
    expect(r.verdict.verdict).toBe('GO')
    expect(r.hoot).toBeNull()
  })

  it('healthy watched devices: the line is OK and nothing is flagged', () => {
    const r = check([...device('Any', 'TalonFX', 15), ...device('Any', 'CANcoder', 4)])
    expect(flagged(r)).toEqual([])
    expect(healthLine(r).state).toBe('ok')
  })

  it('a sticky fault is amber, with the raw field and no decoding', () => {
    const r = check([...device('Any', 'TalonFX', 15), ...device('Any', 'CANcoder', 4, { sticky: 0x104 })])
    const i = item(r, 'foresight/sticky-faults')!
    expect(i.level).toBe('amber')
    expect(i.finding.title).toBe('Intake CANcoder (CANcoder 4) has sticky faults set (field 0x00000104)')
    expect(i.finding.evidence['which faults']).toMatch(/not decoded/)
    expect(healthLine(r).state).toBe('amber')
  })

  it('a device not answering now: its sticky faults are not checked, and a companion-only one drops off CAN', () => {
    const r = check(device('Any', 'TalonFX', 40, { sticky: 1, connected: perSecond(true, [[60, false]]) }))
    expect(item(r, 'foresight/sticky-faults')).toBeUndefined()
    expect(r.report.skipped.find((s) => s.rule === 'foresight/sticky-faults')?.reason).toMatch(/TalonFX 40 on Any: not answering now/)
    expect(item(r, 'can/device-dropout')?.finding.about).toBe('TalonFX 40 on Any')
  })

  it('firmware differing within a model is amber; different models may differ', () => {
    const mixed = check([...device('Any', 'TalonFX', 15), ...device('Any', 'TalonFX', 16, { version: 0x19020000 }), ...device('Any', 'CANcoder', 4, { version: 0x19000000 })])
    const i = item(mixed, 'foresight/firmware-mismatch')!
    expect(i.level).toBe('amber')
    expect(i.finding.title).toBe('Firmware differs within TalonFX (2 versions)')
    expect(i.finding.evidence).toEqual({ 'TalonFX 26.1.0.0 (0x1A010000)': 'Flywheel leader (TalonFX 15)', 'TalonFX 25.2.0.0 (0x19020000)': 'Flywheel follower 16 (TalonFX 16)' })
  })

  it('a reboot in the pit is amber (never proven, so never red)', () => {
    const r = check(device('Any', 'TalonFX', 15, { resets: perSecond(0, [[70, 1]]) }))
    expect(item(r, 'can/device-rebooted')?.level).toBe('amber')
  })

  it('with a snapshot from this run, each device finding says what the snapshot saw (Any = its one CANivore)', () => {
    const codeStartWallMs = Date.parse('2026-10-20T17:00:00Z')
    const taken = new Date(codeStartWallMs + (SETTLE_SECONDS + 20) * 1000).toISOString()
    const snapshot = makeDevicesSnapshot(profileSnapshot(offseason2026), taken)
    const r = check([...device('Any', 'CANcoder', 4, { sticky: 2 }), ...device('Any', 'TalonFX', 40, { sticky: 2 })], null, { snapshot, codeStartWallMs })
    const evidence = (about: string) => r.report.findings.find((f) => f.rule === 'foresight/sticky-faults' && f.about === about)?.evidence['in the robot snapshot']
    expect(evidence('Intake CANcoder (CANcoder 4)')).toMatch(/^CANCoder vers\. H 4 on the canivore1 \("CANCoder vers\. H \(Device ID 4\)"\), serial SIM-\d+-0, firmware 26\.3\.0\.0/)
    expect(evidence('TalonFX 40 on Any')).toBe("not on the snapshot's canivore1")
  })

  it('reports whether hoot is recording, as context only', () => {
    const r = check([{ name: '/Hindsight/Hoot/Recording', type: 'boolean', records: perSecond(true) }, { name: '/Hindsight/Hoot/Status', type: 'string', records: steady('ok') }])
    expect(r.hoot).toMatchObject({ state: 'whole', text: expect.stringMatching(/^Phoenix hoot was recording since start-up settled/) })
    expect(r.verdict.verdict).toBe('GO')
  })
})

describe('joining a watched device to the snapshot', () => {
  it('matches the server\'s model names by prefix, never Talon FX to Talon FXS', () => {
    expect(sameModel('Talon FX vers. C', 'TalonFX')).toBe(true)
    expect(sameModel('Talon FXS vers. A', 'TalonFX')).toBe(false)
    expect(sameModel('Talon FXS vers. A', 'TalonFXS')).toBe(true)
    expect(sameModel('CANCoder vers. H', 'CANcoder')).toBe(true)
    expect(sameModel('Pigeon 2', 'Pigeon2')).toBe(true)
  })
  it('maps rio to the roboRIO bus and Any to the one CANivore, or to nothing with two', () => {
    const one = makeDevicesSnapshot([{ model: 'Talon FX vers. C', id: 1, bus: 'canivore1' }, { model: 'Pigeon 2', id: 0, bus: '' }], '2026-10-20T17:01:00Z')
    const two = makeDevicesSnapshot([{ model: 'Talon FX vers. C', id: 1, bus: 'a' }, { model: 'Talon FX vers. C', id: 1, bus: 'b' }], '2026-10-20T17:01:00Z')
    expect(snapshotBusFor(one, 'rio')).toBe('')
    expect(snapshotBusFor(one, 'Any')).toBe('canivore1')
    expect(snapshotBusFor(two, 'Any')).toBeNull()
    expect(snapshotDeviceFor(two, { bus: 'Any', model: 'TalonFX', id: 1 })).toMatch(/can't tell which bus/)
    expect(snapshotDeviceFor(one, { bus: 'rio', model: 'Pigeon2', id: 0 })).toMatchObject({ model: 'Pigeon 2', bus: '' })
  })
})
