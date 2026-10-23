// The profile builder: profile.json round trip, motors and groups from synthetic logs, snapshot name matching, code
// hints, and (when the real logs are on this computer) the backtest against the hand profiles and a team with no
// profile. Synthetic logs and snapshots are made up here; real logs are read in place and never copied.
import { beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { openWpilog, readNumbers } from '../src/readers/wpilog.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { ADVANTAGEKIT_SIGNALS } from '../src/profiles/advantagekit.ts'
import { offseason2025 } from '../src/profiles/2025-offseason.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles, type InputFile } from '../src/analyze.ts'
import { fromProfile, parseProfileJson, toProfile } from '../src/builder/json.ts'
import { motorsFromLog } from '../src/builder/motors.ts'
import { groupMotors } from '../src/builder/groups.ts'
import { matchByName } from '../src/builder/snapshot.ts'
import { allMotors, applySnapshot, carryConfirmations, draftProfile, draftWarnings, setDevice } from '../src/builder/draft.ts'
import { keepProfile, keptId, keptProfiles, storedProfiles } from '../src/builder/store.ts'
import { PROFILES, profileId } from '../src/profiles/index.ts'
import { codeHead, codeHints, shaWarning, type CodeFile } from '../src/builder/code-hints.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'
import { GitRepo } from '../src/code/git.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { backtestLog } from '../src/builder/backtest.ts'
import { codeMotors, placeInLog, type CodeMotor } from '../src/builder/code-motors.ts'
import { deviceSettings } from '../src/code/check/device-settings.ts'
import { Project } from '../src/code/check/project.ts'
import type { RobotProfile } from '../src/profiles/types.ts'
import type { Finding } from '../src/rules/types.ts'
import { packDoubles, writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { loadFixture, CALGAMES, haveCalGames, readInput } from './helpers/load.ts'
import { makeSnapshot } from './helpers/make-snapshot.ts'

/** RegExps compared by source and flags. */
beforeAll(loadJavaFromDisk)

const plain = (x: unknown): unknown => JSON.parse(JSON.stringify(x, (_k, v) => (v instanceof RegExp ? { regexp: v.source, flags: v.flags } : v)))
const roundTrip = (p: RobotProfile) => toProfile(parseProfileJson(JSON.stringify(fromProfile(p))))

describe('profile.json', () => {
  it.each(PROFILES.map((p) => [`${p.name} @ ${p.code.branch}`, p] as const))('%s survives JSON and back', (_n, p) => {
    const back = roundTrip(p)
    expect(plain(back)).toEqual(plain(p))
    back.zeroing.forEach((z, i) => {
      expect(z.doneMessage).toBeInstanceOf(RegExp)
      expect(z.doneMessage.source).toBe(p.zeroing[i].doneMessage.source)
    })
  })

  it('the snapshot view\'s example profile is a profile.json', () => {
    const json = parseProfileJson(readFileSync('fixtures/robot-snapshot/example-profile.json', 'utf8'))
    const p = toProfile(json)
    expect(p.motorGroups.map((g) => g.motors.length)).toEqual([4, 3, 1])
    expect(p.signals.enabled).toBe('')
    expect(p.zeroing).toEqual([])
  })

  it('names what is wrong with a file that isn\'t one', () => {
    expect(() => parseProfileJson('{', 'x.json')).toThrow('x.json is not JSON')
    expect(() => parseProfileJson('{"name":"a"}')).toThrow(/needs a name and motorGroups/)
    expect(() => parseProfileJson('{"name":"a","motorGroups":[{"name":"g","motors":[{}]}]}')).toThrow(/motor 1 needs a name/)
    expect(() => parseProfileJson('{"name":"a","motorGroups":[],"zeroing":[{"doneMessage":{"source":"(","flags":""}}]}')).toThrow(/not a regular expression/)
    expect(() => parseProfileJson('{"name":"a","motorGroups":[{"name":"g","motors":[],"limits":{"supplyA":40}}]}')).toThrow(/limits need a "where"/)
    expect(() => parseProfileJson('{"name":"a","motorGroups":[{"name":"g","motors":[{"name":"m","canId":"15"}]}]}')).toThrow(/canId must be a whole number/)
  })

  it.each(['q13-spinups', 'q21-follower-mismatch', 'p0-brownout'])('the round-tripped 2026 profile gives the same analysis on %s', (name) => {
    const files = loadFixture(name)
    const a = analyzeFiles(files, offseason2026).analyses.map((x) => x.report)
    const b = analyzeFiles(files, roundTrip(offseason2026)).analyses.map((x) => x.report)
    expect(plain(b)).toEqual(plain(a))
  })

  it('AdvantageKit\'s fixed names agree with the hand-written AdvantageKit profiles', () => {
    for (const p of [offseason2025, offseason2026]) {
      for (const [k, v] of Object.entries(ADVANTAGEKIT_SIGNALS)) if (v !== '' && !(Array.isArray(v) && v.length === 0)) expect((p.signals as Record<string, unknown>)[k], k).toEqual(v)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Synthetic logs

const DS: FixtureEntry[] = [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [25, false], [28, true], [168, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false], [9.5, true], [28, false]] },
  { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[0, true]] },
  { name: '/RealMetadata/ProjectName', type: 'string', records: [[0, 'Example Robot']] },
  { name: '/RealMetadata/GitSHA', type: 'string', records: [[0, 'abc1234def']] },
  { name: '/RealMetadata/GitBranch', type: 'string', records: [[0, 'main']] },
]
const d = (name: string, v = 1): FixtureEntry => ({ name, type: 'double', records: [[1, v], [2, v + 1]] })
const b = (name: string): FixtureEntry => ({ name, type: 'boolean', records: [[1, true]] })

function exampleLog(): FixtureEntry[] {
  return [
    ...DS,
    ...['Module0', 'Module1', 'Module2', 'Module3'].flatMap((m) => ['Drive', 'Turn'].flatMap((t) => [d(`/Drive/${m}/${t}CurrentAmps`), d(`/Drive/${m}/${t}VelocityRadPerSec`), b(`/Drive/${m}/${t}Connected`)])),
    ...['Leader', 'Follower 0', 'Follower 1'].flatMap((m) => [d(`/Shooter/Flywheel/${m}/SupplyCurrentAmps`), d(`/Shooter/Flywheel/${m}/StatorCurrentAmps`), d(`/Shooter/Flywheel/${m}/VelocityRotPerSec`)]),
    d('/Intake/Roller/SupplyCurrentAmps'), d('/Intake/Roller/StatorCurrentAmps'), b('/Intake/Roller/Connected'),
    // Not motors: a computed value, a "current" position, dashboard copies, the PDH, an array.
    d('/RealOutputs/Intake/Pivot/Current Filter Value'), d('/Arm/Position/Current'), d('/Arm/Position/Goal'),
    d('NT:/SmartDashboard/Climber/CurrentAmps'), d('NT:/SmartDashboard/Climber/VelocityRPS'),
    d('/PowerDistribution/TotalCurrent'), { name: '/Elevator/CurrentAmps', type: 'double[]', records: [[1, [0, 1] as unknown as number]] },
    b('/Drive/Gyro/Connected'), b('/RadioStatus/Connected'),
    { name: '/RealOutputs/Alerts/errors', type: 'string[]', records: [[1, []]] },
    { name: '/RealOutputs/Battery/Id', type: 'string', records: [[1, 'B7']] }, d('/BatteryGauge/Valid'),
  ]
}

describe('motors and groups from a log', () => {
  const log = openWpilog(writeWpilog(exampleLog()))
  const { motors, notUsed, limits } = motorsFromLog(log)

  it('finds each motor once, and nothing that isn\'t one', () => {
    expect(motors.map((m) => m.path).sort()).toEqual([
      ...['Module0', 'Module1', 'Module2', 'Module3'].flatMap((m) => [`/Drive/${m}/Drive`, `/Drive/${m}/Turn`]),
      '/Intake/Roller',
      '/Shooter/Flywheel/Follower 0', '/Shooter/Flywheel/Follower 1', '/Shooter/Flywheel/Leader',
    ].sort())
    expect(notUsed.map((n) => n.key)).toContain('NT:/SmartDashboard/Climber/CurrentAmps')
    expect(notUsed.find((n) => n.key === '/Arm/Position/Current')?.why).toMatch(/no velocity/)
    // An array with nothing beside it is no motor either: each element is listed.
    expect(notUsed.map((n) => n.key)).toEqual(expect.arrayContaining(['/Elevator/CurrentAmps[0]', '/Elevator/CurrentAmps[1]']))
    expect(limits).toEqual([])
  })

  it('marks a current that doesn\'t say supply or stator, and reads siblings', () => {
    const drive = motors.find((m) => m.path === '/Drive/Module0/Drive')!
    expect(drive).toMatchObject({ current: '/Drive/Module0/DriveCurrentAmps', velocity: '/Drive/Module0/DriveVelocityRadPerSec', connected: '/Drive/Module0/DriveConnected' })
    expect(drive.supplyCurrent).toBeUndefined()
    expect(motors.find((m) => m.path === '/Intake/Roller')).toMatchObject({ supplyCurrent: '/Intake/Roller/SupplyCurrentAmps', statorCurrent: '/Intake/Roller/StatorCurrentAmps', connected: '/Intake/Roller/Connected' })
  })

  it('groups the swerve modules and the leader with its followers, and nothing else', () => {
    const groups = groupMotors(motors)
    expect(groups.map((g) => [g.name, g.motors.length, g.evidence])).toEqual([
      ['Drive', 4, 'swerve'], ['Turn', 4, 'swerve'], ['Flywheel', 3, 'leader/follower'], ['Roller', 1, 'one motor'],
    ])
  })

  it('does not merge one mechanism name across subsystems (Intake/Pivot, Arm/Pivot, Climber/Pivot)', () => {
    const pivots = openWpilog(writeWpilog(['Intake', 'Arm', 'Climber'].flatMap((s) => [d(`/${s}/Pivot/SupplyCurrentAmps`), d(`/${s}/Pivot/VelocityRotPerSec`)])))
    expect(groupMotors(motorsFromLog(pivots).motors).map((g) => g.name)).toEqual(['Arm pivot', 'Climber pivot', 'Intake pivot'])
  })

  it('reads a TalonFX status struct as one motor', () => {
    const schema: FixtureEntry = { name: 'NT:/.schema/struct:TalonFX', type: 'structschema', records: [[0, 'double supplyCurrent;double statorCurrent;double velocity;double deviceTemp']] }
    const talon = (p: string): FixtureEntry => ({ name: `NT:/Telemetry/${p}/`, type: 'struct:TalonFX', records: [[1, packDoubles([1, 2, 3, 30])]] })
    const s = openWpilog(writeWpilog([schema, talon('shooter/lead'), talon('shooter/follow'), talon('hood/motor')]))
    const found = motorsFromLog(s).motors
    expect(found.map((m) => m.path)).toEqual(['NT:/Telemetry/hood/motor', 'NT:/Telemetry/shooter/follow', 'NT:/Telemetry/shooter/lead'])
    expect(found[0]).toMatchObject({ supplyCurrent: 'NT:/Telemetry/hood/motor/supplyCurrent', temperature: 'NT:/Telemetry/hood/motor/deviceTemp' })
    expect(groupMotors(found).map((g) => [g.name, g.motors.length])).toEqual([['Shooter', 2], ['Hood motor', 1]])
  })

  it('drafts signals, identity, other devices and the warnings', () => {
    const draft = draftProfile({ logs: [{ log, fileName: 'example.wpilog' }] })
    expect(draft.json.codebase).toBe('Example Robot')
    expect(draft.json.code).toEqual({ repo: '', branch: 'main', sha: 'abc1234def' })
    // AdvantageKit's key, then the plain WPILib log's: the draft keeps the log type's list (profiles/sources.ts).
    expect(draft.json.signals?.enabled).toEqual(['/DriverStation/Enabled', 'DS:enabled'])
    expect(draft.json.signals?.alertGroups).toEqual(['/RealOutputs/Alerts'])
    expect(draft.json.otherDevices).toEqual([{ name: 'Drive Gyro', connected: '/Drive/Gyro/Connected' }])
    expect(draft.json.motorGroups.find((g) => g.name === 'Flywheel')).toMatchObject({ sameLoop: true, sameLoopSuggested: true })
    expect(draft.warnings).toEqual([])
    expect(draft.json.battery).toMatchObject({ id: ['/RealOutputs/Battery/Id'], gaugeValid: ['/BatteryGauge/Valid'], numCycles: [] })
    // An unconfirmed supply-or-stator current feeds no rule until the student says which.
    const drive = toProfile(draft.json).motorGroups.find((g) => g.name === 'Drive')!.motors[0]
    expect(drive.supplyCurrent).toBeUndefined()
    expect(drive.statorCurrent).toBeUndefined()
  })
})

describe('older AdvantageKit logs (the shapes of 8033\'s 2023 and 2024 robots)', () => {
  const arr = (name: string, ...values: number[][]): FixtureEntry => ({ name, type: 'double[]', records: values.map((v, i) => [i + 1, v as never]) })

  it('reads `Amps` without "Current", and percent output or speed as a motor\'s sibling', () => {
    const log = openWpilog(writeWpilog([
      d('/Shooter/PivotAmps'), d('/Shooter/PivotVoltage'), d('/Shooter/PivotTempC'),
      d('/Grabber/RollersCurrentAmps'), d('/Grabber/RollersPercentOut'), d('/Grabber/RollersSpeedRPS'),
      d('/Intake/CurrentAmps'), d('/Intake/PercentOut'),
      d('/Vision/Amps'), d('/Vision/latency'),
    ]))
    const { motors, notUsed } = motorsFromLog(log)
    expect(motors.map((m) => [m.path, m.current, m.velocity])).toEqual([
      ['/Grabber/Rollers', '/Grabber/RollersCurrentAmps', '/Grabber/RollersSpeedRPS'],
      ['/Intake', '/Intake/CurrentAmps', undefined],
      ['/Shooter/Pivot', '/Shooter/PivotAmps', undefined],
    ])
    expect(notUsed.map((n) => n.key)).toEqual(['/Vision/Amps'])
  })

  it('reads an array of one as the motor itself, beside its supply current and an array temperature', () => {
    const log = openWpilog(writeWpilog([
      arr('/Swerve/Front Left Module/DriveCurrentAmps', [3], [4]), d('/Swerve/Front Left Module/DriveSupplyCurrentAmps'),
      d('/Swerve/Front Left Module/DriveVelocityMetersPerSec'), arr('/Swerve/Front Left Module/DriveTempCelsius', [30]),
    ]))
    expect(motorsFromLog(log).motors).toEqual([{
      path: '/Swerve/Front Left Module/Drive', from: 'keys',
      supplyCurrent: '/Swerve/Front Left Module/DriveSupplyCurrentAmps', current: '/Swerve/Front Left Module/DriveCurrentAmps[0]',
      velocity: '/Swerve/Front Left Module/DriveVelocityMetersPerSec', temperature: '/Swerve/Front Left Module/DriveTempCelsius[0]',
    }])
  })

  it('reads an array of two as two motors of one mechanism, each with its own element', () => {
    const log = openWpilog(writeWpilog([
      arr('/Elevator/CurrentAmps', [], [1, 2], [3, 4]), arr('/Elevator/TempCelsius', [30, 31]), d('/Elevator/PercentOut'),
      arr('/Climber/CurrentAmps', []), d('/Climber/PercentOut'),
    ]))
    const { motors, notUsed } = motorsFromLog(log)
    expect(motors.map((m) => [m.path, m.current, m.temperature, m.velocity])).toEqual([
      ['/Elevator[0]', '/Elevator/CurrentAmps[0]', '/Elevator/TempCelsius[0]', undefined],
      ['/Elevator[1]', '/Elevator/CurrentAmps[1]', '/Elevator/TempCelsius[1]', undefined],
    ])
    expect(notUsed).toEqual([{ key: '/Climber/CurrentAmps', why: 'an array that is always empty' }])
    const groups = groupMotors(motors)
    expect(groups.map((g) => [g.name, g.evidence, g.motors.map((m) => m.name)])).toEqual([['Elevator', 'one array', ['Elevator 1', 'Elevator 2']]])
    expect(Array.from(readNumbers(log, motors[1].current!)!.v)).toEqual([2, 4])
  })

  it('groups `/Swerve Module N/` folders at the log\'s root as swerve, and no other numbered root folders', () => {
    const log = openWpilog(writeWpilog([
      ...[0, 1, 2, 3].flatMap((n) => ['Drive', 'Steer'].flatMap((t) => [d(`/Swerve Module ${n}/${t}CurrentAmps`), d(`/Swerve Module ${n}/${t}SpeedRPS`)])),
      ...[1, 2, 3].flatMap((n) => [d(`/Shooter ${n}/MotorCurrentAmps`), d(`/Shooter ${n}/MotorVelocityRPS`)]),
      d('/Routing/LeftCurrentAmps'), d('/Routing/LeftPercentOut'),
    ]))
    const groups = groupMotors(motorsFromLog(log).motors)
    expect(groups.filter((g) => g.evidence === 'swerve').map((g) => [g.name, g.motors.map((m) => m.name)])).toEqual([
      ['Drive', ['Swerve module 0 drive', 'Swerve module 1 drive', 'Swerve module 2 drive', 'Swerve module 3 drive']],
      ['Steer', ['Swerve module 0 steer', 'Swerve module 1 steer', 'Swerve module 2 steer', 'Swerve module 3 steer']],
    ])
    // Three shooters are three groups, and a side alone ("Left") is no name: it takes its folder.
    expect(groups.filter((g) => g.evidence === 'one motor').map((g) => g.name)).toEqual(['Routing left', 'Shooter 1 motor', 'Shooter 2 motor', 'Shooter 3 motor'])
    expect(draftWarnings(groups.map((g) => ({ ...g, groupedBy: g.evidence })))).toEqual([])
  })

  it('takes the power board\'s total current when its channels report (100+ plausible records), not one record of garbage', () => {
    const board = (records: [number, number[]][], total: [number, number][]): FixtureEntry[] => [
      ...DS, { name: '/PowerDistribution/ChannelCurrent', type: 'double[]', records: records as never }, { name: '/PowerDistribution/TotalCurrent', type: 'double', records: total },
    ]
    const live = Array.from({ length: 120 }, (_, i): [number, number[]] => [i * 0.02, [i % 7, 2]])
    const reporting = draftProfile({ logs: [{ log: openWpilog(writeWpilog(board(live, [[0, 2], [1, 8]]))), fileName: 'live.wpilog' }] })
    expect(reporting.json.signals?.totalCurrent).toBe('/PowerDistribution/TotalCurrent')
    expect(reporting.guessed.map((g) => g.signal)).toContain('totalCurrent')
    for (const records of [[[0, [8.7e245, 0]]], live.slice(0, 99), live.map(([t]) => [t, [0, 0]])] as [number, number[]][][]) {
      const quiet = draftProfile({ logs: [{ log: openWpilog(writeWpilog(board(records, [[0, 0], [1, 0]]))), fileName: 'quiet.wpilog' }] })
      expect(quiet.json.signals?.totalCurrent).toBe('')
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Snapshot

describe('CAN IDs from a robot snapshot', () => {
  const paths = ['/Swerve/FrontLeft/Drive', '/Swerve/FrontLeft/Turn', '/Swerve/BackRight/Drive', '/Shooter/Leader', '/Shooter/Follower 1', '/Intake/Roller', '/Hood']
  const snapshot = makeSnapshot([
    { id: 1, name: 'FL Drive' }, { id: 2, name: 'FL Steer' }, { id: 7, name: 'BR Drive Kraken' },
    { id: 10, name: 'Shooter Leader' }, { id: 11, name: 'Shooter Follower 1' }, { id: 20, name: 'Intake Roller' },
    { id: 30 }, // still the Tuner X default name
  ])

  it('matches every named device by its Tuner X name', () => {
    const got = Object.fromEntries(matchByName(paths, snapshot).map((m) => [m.path, m.device.id]))
    expect(got).toEqual({ '/Swerve/FrontLeft/Drive': 1, '/Swerve/FrontLeft/Turn': 2, '/Swerve/BackRight/Drive': 7, '/Shooter/Leader': 10, '/Shooter/Follower 1': 11, '/Intake/Roller': 20 })
  })

  it('the motor\'s own name breaks a tie the subsystem folder makes (/Drive/FrontLeft/Turn: "FL Steer", not "FL Drive")', () => {
    const snap = makeSnapshot([{ id: 1, name: 'FL Drive' }, { id: 2, name: 'FL Steer' }, { id: 3, name: 'FR Drive' }, { id: 4, name: 'FR Steer' }])
    const got = Object.fromEntries(matchByName(['/Drive/FrontLeft/Drive', '/Drive/FrontLeft/Turn', '/Drive/FrontRight/Drive', '/Drive/FrontRight/Turn'], snap).map((m) => [m.path, m.device.id]))
    expect(got).toEqual({ '/Drive/FrontLeft/Drive': 1, '/Drive/FrontLeft/Turn': 2, '/Drive/FrontRight/Drive': 3, '/Drive/FrontRight/Turn': 4 })
  })

  it('gives the last motor the last Talon FX, and reads group limits as running on the robot', () => {
    const entries = [...DS, ...paths.flatMap((p) => [d(`${p}/SupplyCurrentAmps`), b(`${p}/Connected`)])]
    const draft = draftProfile({ logs: [{ log: openWpilog(writeWpilog(entries)), fileName: 'x.wpilog' }], snapshot })
    const ids: Record<string, [number | undefined, string | undefined]> = Object.fromEntries(allMotors(draft.json).map(({ motor }) => [motor.logPath, [motor.canId, motor.canIdFrom]]))
    expect(ids['/Hood']).toEqual([30, 'snapshot'])
    expect(Object.values(ids).every((v) => v[0] !== undefined)).toBe(true)
    const shooter = draft.json.motorGroups.find((g) => g.name === 'Shooter')!
    expect(shooter.limits).toMatchObject({ supplyA: 70, supplyEnabled: true, statorA: 120, where: expect.stringMatching(/^as running on the robot/) })
    expect(draft.json.limitsFrom).toEqual({ snapshotTakenAt: '2026-01-01T12:00:00Z' })
  })

  it('a group whose motors run different limits gets none, and a pick by the student refreshes it', () => {
    const snap = makeSnapshot([{ id: 10, name: 'Shooter Leader', limits: { supplyA: 40 } }, { id: 11, name: 'Shooter Follower 1', limits: { supplyA: 30 } }])
    const entries = [...DS, ...['/Shooter/Leader', '/Shooter/Follower 1'].flatMap((p) => [d(`${p}/SupplyCurrentAmps`), b(`${p}/Connected`)])]
    const draft = draftProfile({ logs: [{ log: openWpilog(writeWpilog(entries)), fileName: 'x.wpilog' }], snapshot: snap })
    const g = draft.json.motorGroups[0]
    expect(g.limits).toBeUndefined()
    const follower = g.motors.find((m) => m.logPath === '/Shooter/Follower 1')!
    setDevice(draft.json, snap, follower, { id: 10, bus: 'canivore1' })
    expect(g.limits).toMatchObject({ supplyA: 40 })
    expect(follower.canIdFrom).toBe('you')
  })
})

describe('code hints', () => {
  const files = [
    { path: 'src/main/java/frc/robot/Shooter.java', text: 'class Shooter {\n  static final int LEADER_ID = 10;\n  TalonFX a = new TalonFX(LEADER_ID, "canivore");\n  TalonFX b = new TalonFX(11);\n  Shooter(int motorId) { new TalonFX(motorId); }\n}\n' },
    { path: '.git/HEAD', text: 'ref: refs/heads/event\n' },
    { path: '.git/packed-refs', text: '# pack-refs\n1111111111111111111111111111111111111111 refs/heads/event\n' },
  ]
  /** The .git files among `files`, read as a GitRepo: what the builder does with a chosen folder. */
  const headIn = (all: CodeFile[]) => {
    const git = new Map(all.filter((f) => f.path.startsWith('.git/')).map((f) => [f.path.slice(5), new TextEncoder().encode(f.text)]))
    return codeHead(new GitRepo({ read: async (p) => git.get(p) ?? null, size: async (p) => git.get(p)?.length ?? null, list: async () => [] }))
  }
  it('lists each new TalonFX with its ID, constant and line, and leaves a parameter unresolved', async () => {
    const h = codeHints(files, await headIn(files))
    expect(h.sites.map((s) => [s.id, s.expr, s.line, s.bus])).toEqual([[10, 'LEADER_ID', 3, '"canivore"'], [11, '11', 4, null], [null, 'motorId', 5, null]])
    expect(h.sha).toBe('1111111111111111111111111111111111111111')
    expect(h.branch).toBe('event')
  })
  it('follows an ID through the constructor it is passed to: one site per ID, at the `new TalonFX`', async () => {
    const java = [
      { path: 'src/FollowerIO.java', text: 'class FollowerIO {\n  FollowerIO(int motorID, String canBus) {\n    talon = new TalonFX(motorID, canBus);\n  }\n}\n' },
      { path: 'src/Robot.java', text: 'class Robot extends LoggedRobot {\n  Robot() {\n    new FollowerIO(16, "canivore");\n    new FollowerIO(Ids.SECOND, "canivore");\n    new FollowerIO(isReal() ? 18 : 19, "canivore");\n  }\n}\nclass Ids { static final int SECOND = 17; }\n' },
    ]
    const h = codeHints(java, await codeHead(null))
    expect(h.sites).toEqual([16, 17, null].map((id) => ({ id, expr: 'motorID', bus: 'canBus', file: 'src/FollowerIO.java', line: 3 })))
  })
  it('tells apart two constants of one name by the class written before it', async () => {
    const java = [{ path: 'src/Hood.java', text: 'class Comp { static final int HOOD_ID = 31; }\nclass Practice { static final int HOOD_ID = 32; }\nclass Hood { TalonFX a = new TalonFX(Comp.HOOD_ID); }\n' }]
    expect(codeHints(java, await codeHead(null)).sites.map((s) => [s.id, s.expr])).toEqual([[31, 'Comp.HOOD_ID']])
  })
  it('reads IDs from an interface\'s constants and from Constants.Shooter beside a Shooter subsystem', async () => {
    const java = [
      { path: 'src/RobotMap.java', text: 'package frc.robot;\npublic interface RobotMap {\n  int FEEDER_ID = 21;\n  int KICKER_ID = 22;\n}\n' },
      { path: 'src/Constants.java', text: 'package frc.robot;\npublic final class Constants {\n  public static final class Shooter {\n    public static final int LEADER_ID = 23;\n  }\n}\n' },
      { path: 'src/Shooter.java', text: 'package frc.robot.subsystems;\nclass Shooter extends SubsystemBase implements RobotMap {\n  TalonFX feeder = new TalonFX(FEEDER_ID);\n  TalonFX kicker = new TalonFX(RobotMap.KICKER_ID);\n  TalonFX leader = new TalonFX(Constants.Shooter.LEADER_ID);\n}\n' },
    ]
    expect(codeHints(java, await codeHead(null)).sites.map((s) => [s.id, s.expr])).toEqual([[21, 'FEEDER_ID'], [22, 'RobotMap.KICKER_ID'], [23, 'Constants.Shooter.LEADER_ID']])
  })
  it('leaves out IDs that only simulation code passes (a class named …Sim, or one building it)', async () => {
    const java = [
      { path: 'src/FlywheelIO.java', text: 'class FlywheelIO {\n  FlywheelIO(int leaderID) {\n    new TalonFX(leaderID);\n  }\n}\n' },
      { path: 'src/FlywheelIOSim.java', text: 'class FlywheelIOSim extends FlywheelIO {\n  FlywheelIOSim(int leaderID) { super(leaderID); }\n}\n' },
      { path: 'src/Robot.java', text: 'class Robot extends LoggedRobot {\n  Robot() { flywheel = isReal() ? new FlywheelIO(12) : new FlywheelIOSim(11); }\n}\n' },
    ]
    expect(codeHints(java, await codeHead(null)).sites.map((s) => [s.id, s.file])).toEqual([[12, 'src/FlywheelIO.java']])
  })
  it('warns when the folder is not the commit the log ran', async () => {
    const h = codeHints(files, await headIn(files))
    expect(shaWarning(h, '1111111')).toBeNull()
    expect(shaWarning(h, '2222222')).toMatch(/log ran 2222222/)
  })
  it('reads a real folder\'s commit and branch from .git: a loose ref, a packed one, a detached HEAD, no .git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hindsight-hints-'))
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
      git('init', '-q', '-b', 'event')
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'src/Shooter.java'), files[0].text)
      git('add', '-A')
      git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c')
      const sha = git('rev-parse', 'HEAD')
      const java = [{ path: 'src/Shooter.java', text: files[0].text }]
      const hints = async () => codeHints(java, await codeHead(new GitRepo(nodeGitDir(dir)!)))
      expect(await hints()).toMatchObject({ sha, branch: 'event', notes: [] })
      git('pack-refs', '--all')
      expect(existsSync(join(dir, '.git/refs/heads/event'))).toBe(false)
      expect(await hints()).toMatchObject({ sha, branch: 'event', notes: [] })
      git('checkout', '-q', '--detach')
      expect(await hints()).toMatchObject({ sha, branch: null, notes: [] })
      git('checkout', '-q', '--orphan', 'unborn-test')
      expect(await hints()).toMatchObject({ sha: null, notes: ["Couldn't find the commit of branch unborn-test in .git."] })
      expect(codeHints(java, await codeHead(null))).toMatchObject({ sha: null, branch: null, notes: ["No .git folder: can't tell which commit this code is."] })
      expect((await hints()).sites).toEqual(codeHints(files, { why: '' }).sites.map((s) => ({ ...s, file: 'src/Shooter.java' })))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The code's motors and their log keys (code-motors.ts), and the draft they fill in (code-draft.ts). Invented code.

const java = (path: string, ...lines: string[]): CodeFile => ({ path: `src/main/java/frc/robot/${path}`, text: `${lines.join('\n')}\n` })
const motorsOf = (files: CodeFile[]) => { const p = new Project(files); try { return { motors: codeMotors(p), settings: deviceSettings(p) } } finally { p.close() } }
const show = (m: CodeMotor) => [m.site, m.id, m.currents.map((c) => `${c.kind} ${c.folder.map((x) => (typeof x === 'string' ? x : 'field' in x ? `{${x.field}}` : '*')).join('')}/${c.leaf}`)]

describe('the code\'s motors and their log keys', () => {
  const shooter = [
    java('ShooterIO.java', 'public interface ShooterIO {', '  @AutoLog', '  public static class ShooterIOInputs {', '    public double pivotAmps = 0.0;', '    public double[] rollerCurrentAmps = new double[] {};', '  }', '}'),
    java('ShooterIOReal.java',
      'public class ShooterIOReal implements ShooterIO {',
      '  private final TalonFX pivot = new TalonFX(10, "canivore");',
      '  private final Falcon leader = new Falcon(11);',
      '  private final Falcon follower = new Falcon(12);',
      '  private final StatusSignal<Double> pivotAmps = pivot.getStatorCurrent();',
      '  public ShooterIOReal() { follower.setControl(new Follower(leader.getDeviceID(), false)); }',
      '  public void updateInputs(ShooterIOInputsAutoLogged inputs) {',
      '    inputs.pivotAmps = pivotAmps.getValueAsDouble();',
      '    inputs.rollerCurrentAmps = new double[] {leader.getSupplyCurrent().getValueAsDouble(), follower.getSupplyCurrent().getValueAsDouble()};',
      '  }',
      '}'),
    java('Falcon.java', 'public class Falcon extends TalonFX {', '  public Falcon(int id) { super(id, "rio"); }', '}'),
    java('Shooter.java', 'public class Shooter extends SubsystemBase {', '  ShooterIOInputsAutoLogged inputs = new ShooterIOInputsAutoLogged();', '  ShooterIO io = new ShooterIOReal();', '  public void periodic() { io.updateInputs(inputs); Logger.processInputs("Shooter", inputs); }', '}'),
    java('Robot.java', 'public class Robot extends LoggedRobot {', '  Shooter shooter = new Shooter();', '}'),
  ]

  it('maps each inputs field to its key, current kind and motor, through a subclass\'s super(id) and an array', () => {
    const { motors } = motorsOf(shooter)
    expect(motors.map(show)).toEqual([
      ['ShooterIOReal.java:2', 10, ['stator Shooter/PivotAmps']],
      ['ShooterIOReal.java:3', 11, ['supply Shooter/RollerCurrentAmps[0]']],
      ['ShooterIOReal.java:4', 12, ['supply Shooter/RollerCurrentAmps[1]']],
    ])
    const [, leader, follower] = motors
    expect([follower.follows, follower.group === leader.group]).toEqual(['ShooterIOReal.java:3', true])
  })

  it('follows IDs through a record\'s accessors and a folder built from an inputs field; a loop\'s counter is open', () => {
    const files = [
      java('ModuleIO.java', 'public interface ModuleIO {', '  @AutoLog', '  class ModuleIOInputs { public String prefix = ""; public int moduleNumber = 0; public double driveStatorCurrentAmps = 0.0; }', '}'),
      java('Module.java', 'public class Module {', '  public record ModuleConstants(int id, String prefix, int driveID) {}', '  ModuleIOInputsAutoLogged inputs = new ModuleIOInputsAutoLogged();', '  public void periodic() { Logger.processInputs(String.format("Swerve/%s Module", inputs.prefix), inputs); }', '}'),
      java('ModuleIOReal.java',
        'public class ModuleIOReal implements ModuleIO {',
        '  private final TalonFX drive;',
        '  private final ModuleConstants constants;',
        '  public ModuleIOReal(ModuleConstants constants) { this.constants = constants; drive = new TalonFX(constants.driveID()); }',
        '  public void updateInputs(ModuleIOInputsAutoLogged inputs) { inputs.prefix = constants.prefix(); inputs.moduleNumber = constants.id(); inputs.driveStatorCurrentAmps = drive.getStatorCurrent().getValueAsDouble(); }',
        '}'),
      java('Robot.java', 'public class Robot extends LoggedRobot {', '  Robot() {', '    new ModuleIOReal(new ModuleConstants(0, "Front Left", 3));', '    new ModuleIOReal(new ModuleConstants(1, "Front Right", 5));', '  }', '}'),
    ]
    const { motors } = motorsOf(files)
    expect(motors.map((m) => [m.id, m.marks.Prefix])).toEqual([[3, 'Front Left'], [5, 'Front Right']])
    expect(motors[0].currents[0].folder).toEqual(['Swerve/', { field: 'prefix' }, ' Module'])
    expect(new Set(motors.map((m) => m.group)).size).toBe(1)
    const log = openWpilog(writeWpilog([d('/Swerve/Front Left Module/DriveStatorCurrentAmps'), d('/Swerve/Front Right Module/DriveStatorCurrentAmps')]))
    expect(motors.map((m) => placeInLog(m, log).map((k) => k.key))).toEqual([['/Swerve/Front Left Module/DriveStatorCurrentAmps'], ['/Swerve/Front Right Module/DriveStatorCurrentAmps']])

    // `"Swerve Module " + i` is open; the log's ModuleNumber for each folder tells the modules apart.
    const loop = files.map((f) => (f.path.endsWith('Module.java') ? { ...f, text: f.text.replace('String.format("Swerve/%s Module", inputs.prefix)', '"Swerve Module " + i').replace('public void periodic() {', 'public void periodic() { for (int i = 0; i < 2; i++)') } : f))
    const open = motorsOf(loop).motors
    expect(open[0].currents[0].folder).toEqual(['Swerve Module ', { open: 'i' }])
    const numbered = openWpilog(writeWpilog([0, 1].flatMap((n) => [d(`/Swerve Module ${n}/DriveStatorCurrentAmps`), { name: `/Swerve Module ${n}/ModuleNumber`, type: 'int64', records: [[1, n]] } as FixtureEntry])))
    expect(open.map((m) => placeInLog(m, numbered).map((k) => k.key))).toEqual([['/Swerve Module 0/DriveStatorCurrentAmps'], ['/Swerve Module 1/DriveStatorCurrentAmps']])
  })

  it('names a folder by a method of the IO object (`io.getName()`), answered by each IO', () => {
    const files = [
      java('ModuleIO.java', 'public interface ModuleIO {', '  @AutoLog', '  class ModuleIOInputs { public double driveStatorCurrentAmps = 0.0; }', '  String getName();', '}'),
      java('Module.java', 'public class Module {', '  private final ModuleIO io;', '  ModuleIOInputsAutoLogged inputs = new ModuleIOInputsAutoLogged();', '  public Module(ModuleIO io) { this.io = io; }', '  public void periodic() { Logger.processInputs(String.format("Swerve/%s Module", io.getName()), inputs); }', '}'),
      java('ModuleIOReal.java', 'public class ModuleIOReal implements ModuleIO {', '  private final TalonFX drive;', '  private final String name;', '  public ModuleIOReal(String name, int id) { this.name = name; drive = new TalonFX(id); }', '  public String getName() { return name; }', '  public void updateInputs(ModuleIOInputsAutoLogged inputs) { inputs.driveStatorCurrentAmps = drive.getStatorCurrent().getValueAsDouble(); }', '}'),
      java('Robot.java', 'public class Robot extends LoggedRobot {', '  Robot() { new Module(new ModuleIOReal("Back Left", 4)); new Module(new ModuleIOReal("Back Right", 6)); }', '}'),
    ]
    const { motors } = motorsOf(files)
    expect(motors[0].currents[0].folder).toEqual(['Swerve/', { call: 'getName' }, ' Module'])
    const log = openWpilog(writeWpilog([d('/Swerve/Back Left Module/DriveStatorCurrentAmps'), d('/Swerve/Back Right Module/DriveStatorCurrentAmps')]))
    expect(motors.map((m) => [m.id, placeInLog(m, log).map((k) => k.key)])).toEqual([[4, ['/Swerve/Back Left Module/DriveStatorCurrentAmps']], [6, ['/Swerve/Back Right Module/DriveStatorCurrentAmps']]])
  })

  it('names a shared subsystem\'s folder per object, through a subclass\'s super(io, NAME), and pairs it with its IO', () => {
    const files = [
      java('RollerIO.java', 'public interface RollerIO {', '  @AutoLog', '  class RollerIOInputs { public double statorCurrentAmps = 0.0; }', '}'),
      java('RollerIOReal.java', 'public class RollerIOReal implements RollerIO {', '  private final TalonFX motor;', '  public RollerIOReal(int motorID) { motor = new TalonFX(motorID); }', '  public void updateInputs(RollerIOInputsAutoLogged inputs) { inputs.statorCurrentAmps = motor.getStatorCurrent().getValueAsDouble(); }', '}'),
      java('RollerSubsystem.java', 'public class RollerSubsystem extends SubsystemBase {', '  private final String name;', '  RollerIOInputsAutoLogged inputs = new RollerIOInputsAutoLogged();', '  public RollerSubsystem(RollerIO io, String name) { this.io = io; this.name = name; }', '  public void periodic() { Logger.processInputs(name, inputs); }', '}'),
      java('Funnel.java', 'public class Funnel extends RollerSubsystem {', '  public static final String NAME = "Funnel";', '  public Funnel(RollerIO io) { super(io, NAME); }', '}'),
      java('Robot.java', 'public class Robot extends LoggedRobot {', '  Funnel funnel = new Funnel(new RollerIOReal(19));', '  RollerSubsystem intake = new RollerSubsystem(new RollerIOReal(13), "Intake");', '}'),
    ]
    expect(motorsOf(files).motors.map(show)).toEqual([['RollerIOReal.java:3', 19, ['stator Funnel/StatorCurrentAmps']], ['RollerIOReal.java:3', 13, ['stator Intake/StatorCurrentAmps']]])
  })

  it('pairs each folder with the IO object whose updateInputs fills it, and gives no key when that can\'t be told', () => {
    const rollerIO = [
      java('RollerIO.java', 'public interface RollerIO {', '  @AutoLog', '  class RollerIOInputs { public double statorCurrentAmps = 0.0; public Rotation2d angle = new Rotation2d(); }', '}'),
      java('RollerIOReal.java', 'public class RollerIOReal implements RollerIO {', '  private final TalonFX motor;', '  public RollerIOReal(int motorID) { motor = new TalonFX(motorID); }',
        '  public void updateInputs(RollerIOInputsAutoLogged inputs) { inputs.angle = new Rotation2d(); inputs.statorCurrentAmps = motor.getStatorCurrent().getValueAsDouble(); }', '}'),
    ]
    const intake = (body: string[]) => [...rollerIO, java('Intake.java', 'public class Intake extends SubsystemBase {', ...body, '}'), java('Robot.java', 'public class Robot extends LoggedRobot {', '  Intake intake = new Intake(new RollerIOReal(13), new RollerIOReal(14));', '}')]
    const paired = motorsOf(intake([
      '  RollerIOInputsAutoLogged leaderInputs = new RollerIOInputsAutoLogged();', '  RollerIOInputsAutoLogged followerInputs = new RollerIOInputsAutoLogged();',
      '  private final RollerIO leader;', '  private final RollerIO follower;', '  public Intake(RollerIO leader, RollerIO follower) { this.leader = leader; this.follower = follower; }',
      '  public void periodic() { leader.updateInputs(leaderInputs); follower.updateInputs(followerInputs); Logger.processInputs("Intake/Leader", leaderInputs); Logger.processInputs("Intake/Follower", followerInputs); }',
    ])).motors
    expect(paired.map(show)).toEqual([['RollerIOReal.java:3', 13, ['stator Intake/Leader/StatorCurrentAmps']], ['RollerIOReal.java:3', 14, ['stator Intake/Follower/StatorCurrentAmps']]])
    // An object the IO puts in its inputs (`angle`, a Rotation2d) is no mark: it never stops a key being placed.
    const log = openWpilog(writeWpilog([d('/Intake/Leader/StatorCurrentAmps'), { name: '/Intake/Leader/Angle', type: 'struct:Rotation2d', records: [[1, 0.5]] }]))
    expect(placeInLog(paired[0], log).map((k) => k.key)).toEqual(['/Intake/Leader/StatorCurrentAmps'])
    // The same two folders with nothing tying an IO object to either: no keys, rather than one motor's ID on the other's.
    const unpaired = motorsOf(intake([
      '  RollerIOInputsAutoLogged leaderInputs = new RollerIOInputsAutoLogged();', '  RollerIOInputsAutoLogged followerInputs = new RollerIOInputsAutoLogged();',
      '  public Intake(RollerIO leader, RollerIO follower) {}', '  public void periodic() { Logger.processInputs("Intake/Leader", leaderInputs); Logger.processInputs("Intake/Follower", followerInputs); }',
    ])).motors
    expect(unpaired.map((m) => m.currents)).toEqual([[], []])
  })

  it('tells a subclass\'s constructors of one length apart by what the arguments work out to, and joins a Phoenix 5 follower', () => {
    const files = [
      java('Falcon.java', 'public class Falcon extends TalonFX {', '  public Falcon(int id, double gearing) { super(id); }', '  public Falcon(int id, String canbus) { super(id, canbus); }', '}'),
      java('Lift.java', 'public class Lift {', '  static final String BUS = "canivore";', '  Falcon leader = new Falcon(25, 5.45 / 1.0);', '  Falcon follower = new Falcon(26, BUS);',
        '  Lift() { follower.set(ControlMode.Follower, 25); }', '}'),
      java('Robot.java', 'public class Robot extends LoggedRobot {', '  Lift lift = new Lift();', '}'),
    ]
    const { motors } = motorsOf(files)
    expect(motors.map((m) => [m.id, m.bus, m.follows ?? null])).toEqual([[25, 'the roboRIO bus', null], [26, 'canivore', 'Lift.java:3']])
    expect(motors[1].group).toBe(motors[0].group)
  })

  it('reads a CAN bus built from a constant\'s name, and CTRE\'s two-argument form', () => {
    const files = [
      java('Constants.java', 'public class Constants {', '  public static class Bus { public static final String busName = "Example"; public static final CANBus BUS = new CANBus(Constants.Bus.busName); public static final CANBus LOGGED = new CANBus("", "./logs/example.hoot"); public static final CANBus ROBORIO = new CANBus(); }', '}'),
      java('Robot.java', 'public class Robot extends LoggedRobot {', '  TalonFX a = new TalonFX(1, Constants.Bus.BUS);', '  TalonFX b = new TalonFX(2, Constants.Bus.LOGGED);', '  TalonFX c = new TalonFX(3, Constants.Bus.ROBORIO);', '}'),
    ]
    expect(motorsOf(files).motors.map((m) => [m.id, m.bus])).toEqual([[1, 'Example'], [2, 'the roboRIO bus'], [3, 'the roboRIO bus']])
  })

  it('gives no device for a CAN bus whose argument it can\'t work out, never the roboRIO bus', () => {
    const files = [
      java('Robot.java', 'public class Robot extends LoggedRobot {', '  TalonFX a = new TalonFX(1, new CANBus(Config.busName()));', '}'),
    ]
    // The motor is still listed (it is built), but with no ID or bus: deviceAlong gave no device.
    expect(motorsOf(files).motors.map((m) => [m.id, m.bus])).toEqual([[null, null]])
  })

  it('reads current limits: Phoenix 6 fields, a .withCurrentLimits builder, and Phoenix 5 limit configs', () => {
    const files = [
      java('Arm.java',
        'public class Arm {',
        '  static final double SUPPLY = 40.0;',
        '  TalonFX pivot = new TalonFX(9);',
        '  TalonFX roller = new TalonFX(8);',
        '  TalonFX hood = new TalonFX(7);',
        '  Arm() {',
        '    var config = new TalonFXConfiguration();',
        '    config.CurrentLimits.SupplyCurrentLimit = SUPPLY;',
        '    config.CurrentLimits.SupplyCurrentLimitEnable = true;',
        '    pivot.getConfigurator().apply(config);',
        '    roller.getConfigurator().apply(new TalonFXConfiguration().withCurrentLimits(new CurrentLimitsConfigs().withStatorCurrentLimit(80.0).withStatorCurrentLimitEnable(true)));',
        '    hood.configSupplyCurrentLimit(new SupplyCurrentLimitConfiguration(true, 30.0, 45.0, 0.5));',
        '  }',
        '}'),
      java('Robot.java', 'public class Robot extends LoggedRobot {', '  Arm arm = new Arm();', '}'),
    ]
    const limits = (id: number) => motorsOf(files).settings.filter((s) => s.id === id).map((s) => `${s.field}=${s.value}@${s.where}`)
    expect(limits(9)).toEqual(['SupplyCurrentLimit=40@Arm.java:8', 'SupplyCurrentLimitEnable=true@Arm.java:9'])
    expect(limits(8)).toEqual(['StatorCurrentLimit=80@Arm.java:11', 'StatorCurrentLimitEnable=true@Arm.java:11'])
    expect(limits(7)).toEqual(['SupplyCurrentLimit=30@Arm.java:12', 'SupplyCurrentLimitEnable=true@Arm.java:12'])
  })

  it('fills the draft: kinds, IDs, the follower\'s group and limits marked "from code", and what the log lacks', async () => {
    const files = [...shooter]
    files[1] = { ...files[1], text: files[1].text.replace('public ShooterIOReal() {', 'public ShooterIOReal() { var c = new TalonFXConfiguration(); c.CurrentLimits.SupplyCurrentLimit = 30.0; leader.getConfigurator().apply(c); follower.getConfigurator().apply(c);') }
    const hints = codeHints(files, { sha: 'abc1234def', branch: 'main' })
    const log = openWpilog(writeWpilog([
      ...DS, { name: '/RealMetadata/GitDirty', type: 'string', records: [[0, 'Uncommitted changes']] },
      { name: '/Shooter/RollerCurrentAmps', type: 'double[]', records: [[1, [1, 2] as never]] }, d('/Shooter/RollerVelocity'),
    ]))
    const draft = draftProfile({ logs: [{ log, fileName: 'test.wpilog' }], hints })
    const g = draft.json.motorGroups.find((x) => x.motors.length === 2)!
    expect(g.motors.map((m) => [m.supplyCurrent, m.kindFrom, m.canId, m.canIdFrom])).toEqual([
      ['/Shooter/RollerCurrentAmps[0]', 'code', 11, 'code'], ['/Shooter/RollerCurrentAmps[1]', 'code', 12, 'code'],
    ])
    expect([g.groupFromCode, g.sameLoop, g.sameLoopSuggested, g.limitsFromCode, g.limits?.supplyA]).toEqual([true, true, true, true, 30])
    expect(draft.notes).toEqual([
      'The code builds 1 more Talon FX that this log has no current for: ShooterIOReal.java:2 (ID 10). Their current isn\'t in the battery model.',
      'The robot ran uncommitted changes on top of abc1234: this draft is from the commit, so check what the changes touched.',
    ])
    // Builder-only marks never reach the profile the rules use.
    expect(toProfile(draft.json).motorGroups[0]).not.toHaveProperty('limitsFromCode')
    // Code read again (another commit): its IDs replace the old code's; a student's pick is kept.
    const other = codeHints(files.map((f) => ({ ...f, text: f.text.replace('new Falcon(11)', 'new Falcon(21)') })), { sha: 'fedcba9876', branch: 'main' })
    const again = draftProfile({ logs: [{ log, fileName: 'test.wpilog' }], hints: other })
    const picked = structuredClone(draft.json)
    allMotors(picked).find(({ motor }) => motor.canId === 12)!.motor.canIdFrom = 'you'
    carryConfirmations(picked, again.json)
    expect(allMotors(again.json).map(({ motor }) => [motor.canId, motor.canIdFrom])).toEqual([[21, 'code'], [12, 'you']])
  })
})

describe('review fixes', () => {
  const robotLog = (codebase: string, paths: string[], epoch: number) => openWpilog(writeWpilog([
    ...DS.filter((e) => !e.name.startsWith('/RealMetadata')),
    { name: '/RealMetadata/Codebase', type: 'string', records: [[0, codebase]] },
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[1, epoch]] },
    ...paths.flatMap((p) => [d(`${p}/SupplyCurrentAmps`), b(`${p}/Connected`)]),
  ]))

  it('drafts only the latest robot\'s logs and says which were left out', () => {
    const draft = draftProfile({ logs: [
      { log: robotLog('Old Robot', ['/Arm/Pivot'], 1_700_000_000e6), fileName: 'old.wpilog' },
      { log: robotLog('New Robot', ['/Intake/Roller'], 1_780_000_000e6), fileName: 'new.wpilog' },
    ] })
    expect(draft.json.codebase).toBe('New Robot')
    expect(allMotors(draft.json).map(({ motor }) => motor.logPath)).toEqual(['/Intake/Roller'])
    expect(draft.warnings[0]).toMatch(/1 log is from another robot \(Old Robot\).*old\.wpilog/)
  })

  it('keeps a profile.json\'s code-set limits when a snapshot is dropped', () => {
    const json = parseProfileJson(readFileSync('fixtures/robot-snapshot/example-profile.json', 'utf8'))
    applySnapshot(json, makeSnapshot([1, 2, 3, 4, 10, 11, 12, 20].map((id) => ({ id }))))
    expect(json.motorGroups.map((g) => g.limits?.where)).toEqual(['DriveConstants.java:40', 'Shooter.java:72-75', 'Intake.java:31'])
    expect(json.limitsFrom).toBeUndefined()
  })

  it('carries the student\'s confirmations into a new draft', () => {
    const log = openWpilog(writeWpilog(exampleLog()))
    const first = draftProfile({ logs: [{ log, fileName: 'a.wpilog' }] }).json
    const fly = first.motorGroups.find((g) => g.name === 'Flywheel')!
    fly.name = 'Shooter'; fly.sameLoop = false; delete fly.sameLoopSuggested
    const drive0 = allMotors(first).find(({ motor }) => motor.logPath === '/Drive/Module0/Drive')!.motor
    drive0.statorCurrent = drive0.current; delete drive0.current; drive0.canId = 3; drive0.canIdFrom = 'you'
    const next = draftProfile({ logs: [{ log, fileName: 'a.wpilog' }, { log, fileName: 'b.wpilog' }] }).json
    carryConfirmations(first, next)
    expect(next.motorGroups.find((g) => g.motors.some((m) => m.logPath === '/Shooter/Flywheel/Leader'))).toMatchObject({ name: 'Shooter', sameLoop: false })
    expect(allMotors(next).find(({ motor }) => motor.logPath === '/Drive/Module0/Drive')!.motor).toMatchObject({ statorCurrent: '/Drive/Module0/DriveCurrentAmps', canId: 3, canIdFrom: 'you' })
  })

  it('says so when the Java files build no Talon FX (Kotlin isn\'t read: no team code we have is Kotlin)', async () => {
    const h = codeHints([{ path: 'Shooter.kt', text: 'object Ids { const val LEADER = 10 }\nval a = TalonFX(Ids.LEADER, "rio")\n' }], await codeHead(null))
    expect(h.sites).toEqual([])
    expect(h.notes[0]).toBe('No `new TalonFX(...)` in the folder\'s Java files.')
  })
})

describe('deferred review fixes', () => {
  it('gives every group its own name, even when the folders don\'t tell them apart', () => {
    const m = (path: string) => ({ path, from: 'keys' as const, supplyCurrent: `${path}/SupplyCurrentAmps` })
    const names = groupMotors([m('/A/X/Roller'), m('/B/X/Roller'), m('/A/Y/X/Roller')]).map((g) => g.name)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3)
  })

  it('warns when the student names two groups alike', () => {
    const g = (name: string) => ({ name, motors: [{}, {}, {}, {}] })
    expect(draftWarnings([g('Shooter'), g('shooter '), g('Intake')]).join(' ')).toMatch(/Two groups are called "Shooter"/)
    expect(draftWarnings([g('Shooter'), g('Intake')]).join(' ')).not.toMatch(/Two groups/)
  })

  describe('kept profiles', () => {
    const store = new Map<string, string>()
    globalThis.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } } as Storage
    const json = { ...fromProfile(offseason2026), motorGroups: [] }

    it('use one id everywhere, never a built-in profile\'s', () => {
      store.clear()
      keepProfile(json)
      const [p] = storedProfiles()
      expect(profileId(p)).toBe(keptId(json))
      expect(PROFILES.map(profileId)).not.toContain(profileId(p))
      expect((fromProfile(p) as { keptAs?: string }).keptAs).toBeUndefined()
      expect(toProfile({ ...json, keptAs: 'x' } as typeof json).keptAs).toBeUndefined()
    })

    it('replace the one they were opened as when renamed, and leave others alone', () => {
      store.clear()
      keepProfile({ ...json, name: 'Other' })
      keepProfile(json)
      keepProfile({ ...json, name: 'Renamed' }, keptId(json))
      expect(keptProfiles().map((p) => p.name).sort()).toEqual(['Other', 'Renamed'])
    })
  })
})

// ---------------------------------------------------------------------------------------------------------------
// Real logs, when this computer has them (never copied into the repo)

const PUBLIC = `${homedir()}/code/makers/8033/robot/public-logs`
const MTTD = `${homedir()}/Downloads/hindsight-test/2025-11-event`
const LIBRARY = `${homedir()}/.hindsight/app-data-a/library/logs`
const OLDER = { charged: `${LIBRARY}/2023-2024/2023-10-07/Log_23-10-07_10-06-26_q13.wpilog`, crescendo: `${LIBRARY}/2024-2025/2024-09-28/Log_24-09-28_10-57-20_q9.wpilog` }
const publicLog = (dir: string) => { const p = `${PUBLIC}/${dir}`; return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith('.wpilog')).map((f) => `${p}/${f}`)[0] : undefined }
const bt = (path: string) => backtestLog(openWpilog(new Uint8Array(readFileSync(path))), PROFILES)

describe('backtest against the hand profiles (real logs)', () => {
  it.skipIf(!haveCalGames).each(['q13', 'q21', 'p0'] as const)('8033 2026 %s: 19 of 19, every hand group', (k) => {
    const r = bt(CALGAMES[k])
    expect([r.found, r.handMotors, r.missed.length, r.falsePositives.length]).toEqual([19, 19, 0, 0])
    expect(r.handGroups.filter((g) => g.exact).length).toBe(r.handGroups.length)
  })
  it.skipIf(!existsSync(MTTD))('8033 2025 November event: 16 of 16 on every log', () => {
    const logs = readdirSync(MTTD).filter((f) => f.endsWith('.wpilog'))
    expect(logs.length).toBeGreaterThan(10)
    for (const f of logs) {
      const r = bt(`${MTTD}/${f}`)
      expect([f, r.found, r.handMotors, r.missed.length, r.falsePositives.length]).toEqual([f, 16, 16, 0, 0])
    }
  })
  it.skipIf(!publicLog('340-NYRO-Q18')).each([['340-NYRO-Q18', 19], ['340-DALY-Q70', 20]] as const)('%s (TalonFX structs): %i, no false positives', (dir, n) => {
    const r = bt(publicLog(dir)!)
    expect([r.found, r.handMotors, r.falsePositives.length]).toEqual([n, n, 0])
  })
  it.skipIf(!publicLog('2151-ILCH-Q19'))('2151: 8 motors, grouped Drive and Turn, supply or stator to confirm', () => {
    const r = bt(publicLog('2151-ILCH-Q19')!)
    expect(r.builtGroups).toEqual([{ name: 'Drive', size: 4, evidence: 'swerve' }, { name: 'Turn', size: 4, evidence: 'swerve' }])
    expect(r.confirmKind).toHaveLength(8)
  })
  // No hand profile for these robots: the motor counts come from their code (Charged-Up and Crescendo, counted by hand
  // on 2026-10-22). 2024 logs its elevator's two motors as one value and its climber not at all, so 16 of 18.
  it.skipIf(!existsSync(OLDER.charged))('8033 2023 CalGames Q13: all 15 motors in the code, swerve and the elevator grouped', () => {
    const r = bt(OLDER.charged)
    expect(r.falsePositives).toHaveLength(15)
    expect(r.builtGroups.filter((g) => g.evidence !== 'one motor')).toEqual([
      { name: 'Drive', size: 4, evidence: 'swerve' }, { name: 'Steer', size: 4, evidence: 'swerve' }, { name: 'Elevator', size: 2, evidence: 'one array' },
    ])
    expect(r.warnings).toEqual([])
  })
  it.skipIf(!existsSync(OLDER.crescendo))('8033 2024 Chezy Q9: 16 of the code\'s 18 motors, every one the log has', () => {
    const r = bt(OLDER.crescendo)
    expect(r.falsePositives).toHaveLength(16)
    expect(r.builtGroups.filter((g) => g.evidence !== 'one motor')).toEqual([{ name: 'Drive', size: 4, evidence: 'swerve' }, { name: 'Turn', size: 4, evidence: 'swerve' }])
    expect(r.notUsed).toEqual([])
  })
  const galileo = `${PUBLIC}/4322-galileo/Q98/akit_26-05-01_19-10-06_galileo_q98.wpilog`
  it.skipIf(!existsSync(galileo))('4322 (…StatorAmps / …SupplyAmps keys): 18 motors, swerve and three leader/follower groups', () => {
    const r = bt(galileo)
    expect(r.falsePositives).toHaveLength(18)
    expect(r.builtGroups.filter((g) => g.evidence !== 'one motor').map((g) => `${g.name} ${g.size}`)).toEqual(['Drive 4', 'Turn 4', 'Rollers 2', 'Flywheel 2', 'Spindexer 2'])
    expect(r.confirmKind).toEqual([])
  })
  it.skipIf(!publicLog('3602-MICMP2-Q3'))('3602: 0 motors (2 dashboard copies listed, not used)', () => {
    const r = bt(publicLog('3602-MICMP2-Q3')!)
    expect(r.builtGroups).toEqual([])
    expect(r.notUsed.map((n) => n.why)).toEqual(['a dashboard copy', 'a dashboard copy'])
  })
})

// A team with no profile: the 2026 CalGames logs with the built-in profiles hidden. The draft comes from the log; the
// CAN IDs from a synthetic snapshot whose applied limits are the hand profile's (so limits match by construction, and
// are not what is compared) and from dropdowns set as a student would, to the hand profile's IDs.

/**
 * Rules that read only motors, signals and battery: everything but the ones over limits, zeroing, cameras, other devices, the state machine and the power board.
 * can/input-disconnected reports the Connected flags the profile does not name, so a builder profile that maps no cameras or devices leaves it more.
 */
const NOT_COMPARED = ['power/limit-not-applied', 'mech/zero-not-completed', 'vision/outliers', 'vision/stale', 'can/device-dropout', 'can/input-disconnected', 'mech/stuck-state', 'power/pd-not-reporting', 'meta/not-checked']

describe.skipIf(!haveCalGames)('a team with no profile (8033 2026 CalGames logs, built-in profiles hidden)', () => {
  const inputs: InputFile[] = [CALGAMES.q13, CALGAMES.q21, CALGAMES.p0].map(readInput)
  const logs = inputs.map((f) => openWpilog(f.bytes))
  const hand = chooseProfile(logs[0], PROFILES).profile
  const handMotors = hand.motorGroups.flatMap((g) => g.motors.map((m) => ({ g, m })))
  const keysOf = (m: { supplyCurrent?: string; statorCurrent?: string }) => [m.supplyCurrent, m.statorCurrent].filter(Boolean)
  const snapshot = makeSnapshot(handMotors.map(({ g, m }) => ({ id: m.canId!, limits: g.limits })))
  const draft = draftProfile({ logs: logs.map((log, i) => ({ log, fileName: inputs[i].name })), snapshot })
  // The confirm step: each motor's Talon FX, as a student would pick it from the dropdown.
  for (const { motor } of allMotors(draft.json)) {
    const h = handMotors.find(({ m }) => keysOf(m).some((k) => keysOf(motor).includes(k)))!
    if (motor.canId === undefined) setDevice(draft.json, snapshot, motor, { id: h.m.canId!, bus: 'canivore1' })
  }
  const built = toProfile(draft.json)
  const builtIn = analyzeFiles(inputs).analyses
  const fromBuilt = analyzeFiles(inputs, undefined, [built]).analyses

  // Built names → hand names, through the motors' keys.
  const rename = new Map<string, string>()
  for (const g of built.motorGroups) for (const m of g.motors) {
    const h = handMotors.find(({ m: hm }) => keysOf(hm).some((k) => keysOf(m).includes(k)))!
    rename.set(m.name, h.m.name)
    rename.set(g.name, h.g.name)
  }
  // One pass, longest name first, so "Flywheel follower 1" never rewrites inside an already-mapped name.
  const names = new RegExp([...rename.keys()].sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  const mapNames = (s: string | null) => (s === null ? null : s.replace(names, (k) => rename.get(k)!))
  const compared = (fs: Finding[], map: boolean) => fs.filter((f) => !NOT_COMPARED.includes(f.rule))
    .map((f) => ({ rule: f.rule, about: map ? mapNames(f.about) : f.about, severity: f.severity, time: f.time === null ? null : +f.time.toFixed(2), measured: f.measured?.map((x) => ({ ...x, label: map ? mapNames(x.label)! : x.label })) }))
    .sort((a, b) => `${a.rule} ${a.about} ${a.time}`.localeCompare(`${b.rule} ${b.about} ${b.time}`))

  it('every motor got a CAN ID: logged ones from the log, the rest by the student', () => {
    const from = allMotors(draft.json).map(({ motor }) => motor.canIdFrom)
    expect(from.filter((f) => f === 'log')).toHaveLength(4)
    expect(from.every((f) => f === 'log' || f === 'you' || f === 'snapshot')).toBe(true)
    expect(draft.json.motorGroups.every((g) => g.limits?.where.startsWith('as running on the robot'))).toBe(true)
  })

  it.each([0, 1, 2])('log %i: the built profile fits, and the motor, signal and battery findings are the built-in profile\'s', (i) => {
    expect(fromBuilt[i].match.fileName).toBe(builtIn[i].match.fileName)
    expect(fromBuilt[i].match.profile.name).toBe(built.name)
    expect(fromBuilt[i].match.profileChoice.misfit).toBe(false)
    const a = compared(builtIn[i].report.findings, false), b = compared(fromBuilt[i].report.findings, true)
    expect(b).toEqual(a)
    if (builtIn[i].match.fileName.includes('q21')) {
      expect(a.length).toBeGreaterThanOrEqual(2)
      expect(a.map((f) => f.rule)).toContain('mech/follower-mismatch')
    }
  })

  it.each([0, 1, 2])('log %i: what is not checked beyond the built-in profile is zeroing, cameras and the CAN bus (the builder maps none)', (i) => {
    const skipped = (r: typeof builtIn[0]) => new Set(r.report.skipped.map((s) => s.rule))
    const extra = [...skipped(fromBuilt[i])].filter((r) => !skipped(builtIn[i]).has(r)).sort()
    expect(extra).toEqual(['can/bus-dropout', 'mech/zero-not-completed', 'vision/outliers', 'vision/stale'])
  })
})

