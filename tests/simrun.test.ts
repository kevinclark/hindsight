// sim-run's checks on made-up harness output (the lines tools/sim-run/SimRunHarness.java prints). No JVM runs here;
// the runs against real robot code are a backtest outside CI (Phoenix sim runs in real time).
import { describe, expect, it } from 'vitest'
import { readRun } from '../src/simrun/events.ts'
import { autoScenarios, NO_TEAM_FILE, readTeamFile, runsOf, STARTUP, type Run, type Zero } from '../src/simrun/scenario.ts'
import { crash } from '../src/simrun/checks/crash.ts'
import { zeroes } from '../src/simrun/checks/zero.ts'
import { expectations } from '../src/simrun/checks/expect.ts'
import { alliances } from '../src/simrun/checks/alliance.ts'
import { autos } from '../src/simrun/checks/auto.ts'
import type { Context, RunResult } from '../src/simrun/checks/types.ts'
import { openWpilog } from '../src/readers/wpilog.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

/** One harness line: time, kind, fields. */
type Line = [number, string, ...string[]]
const harness = (lines: Line[]) => lines.map(([t, kind, ...f]) => ['[sim-run]', t.toFixed(4), kind, ...f].join('\t')).join('\n')
/** A command field: id|name|requirements|default|origin. */
const cmd = (id: string, name: string, needs = '', isDefault = false, origin = 'trigger') => [id, name, needs, isDefault ? 'default' : '', origin].join('|')

const HOOD: Zero = { name: 'hood', done: /Rezeroed hood/, once: false, fromFile: true }
const run = (label: string): Run => ({ ...runsOf(STARTUP)[0], label })
const result = (output: string, r: Run = run('run'), log: Uint8Array | null = null): RunResult => ({ run: r, record: readRun(output), log: log ? openWpilog(log) : null, repeat: 1, wallSeconds: 1, killed: false })
const context = (results: RunResult[], extra: Partial<Context> = {}): Context => ({ results, zeroes: [HOOD], teamPackage: 'frc.robot.', poseKey: '/RealOutputs/Odometry/Robot', ...extra })

/** Enabled at 5 s; the hood zero finishes 0.45 s later, right after its message (the healthy run). */
const healthy = harness([
  [2, 'started'], [2, 'step', '0.000 mode disabled'], [5, 'step', '3.000 mode teleop'],
  [5.01, 'init', cmd('z1', 'SequentialCommandGroup', 'DrumSubsystem')],
  [5.45, 'out', 'Rezeroed hood'], [5.4505, 'finish', cmd('z1', 'SequentialCommandGroup', 'DrumSubsystem')],
  [10, 'step', '8.000 mode disabled'], [10.2, 'end'],
])

/** CalGames Q13: 0.12 s into auto the intake group takes the drum and the zero never prints. */
const q13 = harness([
  [2, 'started'], [2, 'step', '0.000 mode disabled'], [5, 'step', '3.000 mode auto'],
  [5.01, 'init', cmd('z1', 'SequentialCommandGroup', 'DrumSubsystem')],
  [5.13, 'interrupt', cmd('z1', 'SequentialCommandGroup', 'DrumSubsystem'), cmd('p1', 'ParallelCommandGroup', 'IndexerSubsystem,DrumSubsystem')],
  [5.13, 'init', cmd('p1', 'ParallelCommandGroup', 'IndexerSubsystem,DrumSubsystem')],
  [10, 'step', '8.000 mode disabled'], [10.01, 'interrupt', cmd('p1', 'ParallelCommandGroup', 'IndexerSubsystem,DrumSubsystem')], [10.2, 'end'],
])

describe('reading a run', () => {
  it('reads modes, command lives and printed lines at robot time', () => {
    const record = readRun(q13)
    expect(record.periods.map((p) => p.mode)).toEqual(['disabled', 'auto', 'disabled'])
    const [zero, intake] = record.lives
    expect(zero).toMatchObject({ how: 'interrupted', start: 5.01, end: 5.13 })
    expect(zero.by?.requirements).toEqual(['DrumSubsystem', 'IndexerSubsystem']) // sorted: Java prints a set in any order
    expect(intake.how).toBe('interrupted')
    expect(intake.by).toBeNull() // disabled, not another command
  })

  it('gives a line from native code the last time seen', () => {
    const record = readRun(`${harness([[3.5, 'started']])}\n[phoenix] CANbus Connected`)
    expect(record.console).toEqual([{ t: 3.5, stream: 'native', text: '[phoenix] CANbus Connected' }])
  })
})

describe('zero checks', () => {
  it('names the command that cut off the zero, using the run where it finished to know which command it is', () => {
    const findings = zeroes(context([result(healthy, run('startup')), result(q13, run('auto'))]))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ check: 'zero/cut-off', run: 'auto' })
    expect(findings[0].message).toContain('cut off 0.12 s after it started')
    expect(findings[0].details[1]).toContain('ParallelCommandGroup (needs DrumSubsystem, IndexerSubsystem)')
  })

  it('knows the zero when its requirements print in another order, or it finishes 38 ms after its message', () => {
    const otherOrder = healthy.replace(/DrumSubsystem/g, 'IntakeSubsystem,DrumSubsystem').replace('5.4505\tfinish', '5.4880\tfinish')
    const cut = q13.replace(/SequentialCommandGroup\|DrumSubsystem/g, 'SequentialCommandGroup|DrumSubsystem,IntakeSubsystem')
    expect(zeroes(context([result(otherOrder, run('startup')), result(cut, run('auto'))])).map((f) => f.check)).toEqual(['zero/cut-off'])
  })

  it('stays quiet on a healthy run', () => {
    expect(zeroes(context([result(healthy)]))).toEqual([])
  })

  it('says when a zero the team named never printed', () => {
    const findings = zeroes(context([result(q13)]))
    expect(findings.map((f) => f.check)).toEqual(['zero/never-done'])
  })

  it('says when a zero that should run once ran on every enable', () => {
    const twice = harness([
      [2, 'started'], [5, 'step', '3 mode teleop'], [5.4, 'out', 'Rezeroed hood'], [8, 'step', '6 mode disabled'],
      [10, 'step', '8 mode teleop'], [10.4, 'out', 'Rezeroed hood'], [12, 'step', '10 mode disabled'], [12.2, 'end'],
    ])
    const findings = zeroes(context([result(twice)], { zeroes: [{ ...HOOD, once: true }] }))
    expect(findings.map((f) => f.message)).toEqual(['The hood zero ran on 2 enables; your scenario file says it runs once.'])
  })
})

describe('crash', () => {
  it('reports an exception while building the Robot object, at the first lines of team code', () => {
    const output = [
      harness([[0.03, 'out', '********** Robot program starting **********']]),
      'Error at frc.robot.Camera.getName(Camera.java:120): Unhandled exception instantiating robot frc.robot.Camera java.lang.NullPointerException: Cannot invoke "getName()" because "this.io" is null',
      '\tat frc.robot.Camera.getName(Camera.java:120)', '\tat frc.robot.Camera.<init>(Camera.java:72)',
      '\tat edu.wpi.first.wpilibj.RobotBase.runRobot(RobotBase.java:370)',
    ].join('\n')
    const [finding] = crash(context([result(output)]))
    expect(finding.message).toBe('The robot program crashed while starting (in the Robot constructor or robotInit): NullPointerException: Cannot invoke "getName()" because "this.io" is null')
    expect(finding.details).toEqual(['at Camera.getName (Camera.java:120)', 'called from Camera.<init> (Camera.java:72)'])
  })

  it('says the mode the robot was in when it stopped, and blames the harness for a harness error', () => {
    const inTeleop = harness([[2, 'started'], [2, 'step', '0 mode disabled'], [5, 'step', '3 mode teleop'], [7.5, 'out', 'driving']])
    expect(crash(context([result(inTeleop)]))[0].message).toBe('The robot program stopped 5.5 s after start, in teleop, without printing an exception.')
    const badSelect = harness([[2, 'started'], [4.6, 'harness-error', 'java.lang.IllegalArgumentException: no chooser Autos']])
    expect(crash(context([result(badSelect)])).map((f) => f.check)).toEqual(['run/harness-error'])
  })

  it('is quiet when the timeline reached its end', () => {
    expect(crash(context([result(healthy)]))).toEqual([])
  })
})

describe('the team file', () => {
  const team = readTeamFile(JSON.stringify({
    scenarios: [{ name: 'B', steps: [{ disabled: 3 }, { teleop: 6, press: [{ at: 0.5, driver: 'b', for: 5, expect: [{ message: 'Intake zeroed', within: 3 }, { finish: true, within: 3 }] }] }] }],
  }), 'sim-run.json')

  it('turns a press into timeline lines with a marker, released after its hold', () => {
    const [b] = runsOf(team.scenarios[0])
    expect(b.timeline).toEqual(['0.000 alliance Blue1', '0.000 mode disabled', '2.500 choosers', '3.000 mode teleop', '3.500 button 0 2 1 #p1', '8.490 button 0 2 0', '9.200 end'])
  })

  it('plays a press at 0 before the mode, so the robot sees both in the same loop', () => {
    const atEnable = readTeamFile('{"scenarios":[{"steps":[{"disabled":3},{"auto":2,"press":[{"at":0,"driver":"leftTrigger"}]}]}]}', 'f.json')
    const lines = runsOf(atEnable.scenarios[0])[0].timeline
    expect(lines.indexOf('3.000 axis 0 2 1 #p1')).toBeLessThan(lines.indexOf('3.000 mode auto'))
  })

  it('says what is wrong with a bad press', () => {
    expect(() => readTeamFile('{"scenarios":[{"steps":[{"teleop":2,"press":[{"at":1,"pilot":"b"}]}]}]}', 'f.json')).toThrow(/needs one controller \(driver, operator\)/)
    expect(() => readTeamFile('{"scenarios":[{"steps":[{"teleop":2,"press":[{"at":1,"driver":"trigger"}]}]}]}', 'f.json')).toThrow(/"trigger" is not an Xbox input/)
    expect(() => readTeamFile('{"scenarios":[{"steps":[{"teleop":5,"press":[{"at":6,"driver":"b"}]}]}]}', 'f.json')).toThrow(/a press at 6 s is outside this 5 s step/)
    expect(() => readTeamFile('{"zeroes":[{"name":"hood"}]}', 'f.json')).toThrow(/zero 1 needs "name" and "done"/)
  })

  it('checks a message and finish expectation from the moment of the press', () => {
    const [plan] = runsOf(team.scenarios[0])
    const output = harness([
      [2, 'started'], [2, 'step', '0.000 mode disabled'], [5, 'step', '3.000 mode teleop'], [5.5, 'step', '3.500 button 0 2 1 #p1'],
      [5.51, 'init', cmd('g1', 'ParallelCommandGroup', 'DrumSubsystem,SlapdownSubsystem')],
      [10.5, 'step', '8.490 button 0 2 0'], [10.51, 'interrupt', cmd('g1', 'ParallelCommandGroup', 'DrumSubsystem,SlapdownSubsystem')], [11.2, 'end'],
    ])
    const findings = expectations(context([result(output, plan)]))
    expect(findings.map((f) => f.check)).toEqual(['expect/message', 'expect/finish'])
    expect(findings[1].details).toEqual(['ParallelCommandGroup (needs DrumSubsystem, SlapdownSubsystem): stopped after 5.0 s without finishing'])
  })
})

/** WPILib's Pose2d struct layout, as a log announces it. */
const POSE_SCHEMA: FixtureEntry[] = [
  { name: '/.schema/struct:Pose2d', type: 'structschema', records: [[0, 'Translation2d translation;Rotation2d rotation']] },
  { name: '/.schema/struct:Translation2d', type: 'structschema', records: [[0, 'double x;double y']] },
  { name: '/.schema/struct:Rotation2d', type: 'structschema', records: [[0, 'double value']] },
]

describe('autos and alliances', () => {
  const [auto, none] = autoScenarios({ key: 'Autos', options: ['Left', 'None'], defaultOption: 'None' }, NO_TEAM_FILE, 15)
  /** An auto run whose pose log moves `dx` in x after the start-pose reset. */
  const autoRun = (r: Run, dx: number, extra: Line[] = []) => {
    const output = harness([[2, 'started'], [2, 'step', '0 mode disabled'], [5, 'step', '3 mode auto'], ...extra, [20, 'step', '18 mode disabled'], [21.2, 'end']])
    const log = writeWpilog([...POSE_SCHEMA, { name: '/RealOutputs/Odometry/Robot', type: 'struct:Pose2d', records: [[5.1, { x: 8, y: 4, rot: 0 }], [19, { x: 8 + dx, y: 4, rot: 0 }]] }])
    return result(output, r, log)
  }

  it('fires when red drives the same way as blue, and not when it drives the other way', () => {
    const [blue, red] = runsOf(auto)
    expect(alliances(context([autoRun(blue, 3), autoRun(red, 3)])).map((f) => f.check)).toEqual(['alliance/same-on-both'])
    expect(alliances(context([autoRun(blue, 3), autoRun(red, -3)]))).toEqual([])
  })

  it("reports the auto's own command still running at the end, not wrappers or a state machine's later commands", () => {
    const [left] = runsOf(auto)
    const [noneBlue] = runsOf(none)
    const stillRunning: Line[] = [
      [5.01, 'init', cmd('r1', 'DeferredCommand')], // Choreo's routine: needs nothing, runs to the end by design
      [5.024, 'init', cmd('s1', 'SequentialCommandGroup', 'SwerveSubsystem')], // the auto's paths
      [5.08, 'init', cmd('p1', 'ParallelCommandGroup', 'IntakeSubsystem')], // the INTAKE state's group
    ]
    const findings = autos(context([autoRun(left, 3, stillRunning), autoRun(noneBlue, 0, [[5.01, 'init', cmd('r2', 'DeferredCommand')]])]))
    expect(findings.map((f) => f.check)).toEqual(['auto/unfinished'])
    expect(findings[0].details).toEqual(['still running: SequentialCommandGroup (needs SwerveSubsystem)'])
  })
})
