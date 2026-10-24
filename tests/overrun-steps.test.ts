// loop/overrun names the slow step from the robot console's Tracer lines. Synthetic logs, plus the team's log A when it is listed.
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { analyzeFiles } from '../src/analyze.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { LOGS, readInput } from './helpers/load.ts'

const STEP_LABEL = 'slow steps over 10 ms (console)'
const ORIGINAL_NEXT_STEP = 'Use the Tracer/* entries to find the slow step in auto and move it off the main loop or cache it.'

// Auto is 20-35 s, teleop 40-60 s. Every second sample of each loop is late in auto (worse than teleop).
function loopTimes(): [number, number][] {
  const records: [number, number][] = []
  for (let i = 0; i < 100; i++) records.push([20 + i * 0.1, i % 2 === 0 ? 60 : 15])
  for (let i = 0; i < 100; i++) records.push([40 + i * 0.1, 15])
  return records
}

const base: FixtureEntry[] = [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false], [40, true], [60, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
  { name: '/RealOutputs/LoggedRobot/FullCycleMS', type: 'double', records: loopTimes() },
]

function consoleOf(records: [number, string][]): FixtureEntry {
  return { name: '/RealOutputs/Console', type: 'string', records }
}

function overrunFinding(extra: FixtureEntry[]) {
  const report = analyzeFiles([{ name: 'synthetic.wpilog', bytes: writeWpilog([...base, ...extra]) }], offseason2026).analyses[0].report
  const finding = report.findings.find((f) => f.rule === 'loop/overrun')
  if (!finding) throw new Error('loop/overrun did not fire')
  return finding
}

const epoch = (name: string, seconds: string) => `\t${name}: ${seconds}s\n`

describe('loop/overrun slow steps', () => {
  // Real logs split a list of epochs between records at a line break (the team's 2026 logs and one practice log: ~7,700 records,
  // none cut mid-line).
  it('names the worst step, with epoch lines split across two records', () => {
    const finding = overrunFinding([consoleOf([
      [21, epoch('SwerveSubsystem.periodic()', '0.018531') + epoch('buttons.run()', '0.007865') + 'Warning at edu.wpi.first.wpilibj.Tracer.lambda$printEpochs$0(Tracer.java:62): \tDrumSubsystem.periodic(): 0.032s\n'],
      [21.1, '\tSwerveSubsystem.periodic(): 0.608s\n'],
      [22, epoch('SwerveSubsystem.periodic()', '0.012000') + epoch('DrumSubsystem.periodic()', '0.001373')],
    ])])
    expect(finding.evidence[STEP_LABEL]).toBe('SwerveSubsystem.periodic() in 3 overrun loops, worst 608 ms; DrumSubsystem.periodic() in 1, worst 32 ms')
    expect(finding.nextStep).toBe('Start with SwerveSubsystem.periodic(): it took over 10 ms in 3 overrun loops (worst 608 ms). Move its slow work off the main loop or cache it.')
  })

  it('lists the top three by worst time, counts a "Warning at" line, and keeps a command name with spaces', () => {
    const finding = overrunFinding([consoleOf([[21, [
      epoch('A.periodic()', '0.050'), epoch('B.periodic()', '0.040'), epoch('B.periodic()', '0.011'),
      epoch('C.periodic()', '0.030'), epoch('D.periodic()', '0.020'), epoch('E.periodic()', '0.0099'),
      'Warning at edu.wpi.first.wpilibj.Tracer.lambda$printEpochs$0(Tracer.java:62): \tF.periodic(): 0.080s\n',
      epoch('Teleop drive.execute()', '0.060'),
    ].join('')]])])
    expect(finding.evidence[STEP_LABEL]).toBe('F.periodic() in 1 overrun loop, worst 80 ms; Teleop drive.execute() in 1, worst 60 ms; A.periodic() in 1, worst 50 ms')
  })

  it('names robotPeriodic() alone, but not beside a subsystem over 10 ms', () => {
    const alone = overrunFinding([consoleOf([[21, epoch('robotPeriodic()', '0.090') + epoch('buttons.run()', '0.004')]])])
    expect(alone.evidence[STEP_LABEL]).toBe('robotPeriodic() in 1 overrun loop, worst 90 ms')
    const beside = overrunFinding([consoleOf([[21, epoch('robotPeriodic()', '0.090') + epoch('Arm.periodic()', '0.025')]])])
    expect(beside.evidence[STEP_LABEL]).toBe('Arm.periodic() in 1 overrun loop, worst 25 ms')
    expect(beside.nextStep).toMatch(/^Start with Arm\.periodic\(\): /)
  })

  it('counts only epochs inside the worst window', () => {
    const finding = overrunFinding([consoleOf([
      [5, epoch('Early.periodic()', '0.500')],
      [21, epoch('Auto.periodic()', '0.020')],
      [45, epoch('Teleop.periodic()', '0.300')],
    ])])
    expect(finding.evidence[STEP_LABEL]).toBe('Auto.periodic() in 1 overrun loop, worst 20 ms')
  })

  it('is exactly the old finding without a console, or with no step over 10 ms', () => {
    const without = overrunFinding([])
    const quiet = overrunFinding([consoleOf([[21, epoch('Auto.periodic()', '0.004')], [45, epoch('Teleop.periodic()', '0.300')]])])
    expect(without.evidence[STEP_LABEL]).toBeUndefined()
    expect(Object.keys(without.evidence)).toEqual([
      'auto: median loop (ms)', 'auto: share over 20 ms (%)', 'auto: p99 (ms)', 'auto: worst (ms)',
      'teleop: share over 20 ms (%)', 'teleop: p99 (ms)', 'teleop: worst (ms)',
    ])
    expect(without.nextStep).toBe(ORIGINAL_NEXT_STEP)
    expect(JSON.stringify(quiet)).toBe(JSON.stringify(without))
  })
})

describe('loop/overrun slow steps on the team\'s log A', () => {
  const path = LOGS.a
  it.skipIf(!existsSync(path))('names SwerveSubsystem.periodic()', () => {
    const report = analyzeFiles([readInput(path)], offseason2026).analyses[0].report
    const finding = report.findings.find((f) => f.rule === 'loop/overrun')
    // Auto is the worse period (26.7 % of loops over 20 ms against 4.2 % in teleop). The log has 38 Swerve epochs over
    // 10 ms in all (worst 608 ms); the other 30 are outside auto and must not be counted.
    expect(finding?.evidence[STEP_LABEL]).toBe('SwerveSubsystem.periodic() in 8 overrun loops, worst 39.4 ms')
    expect(finding?.nextStep).toBe('Start with SwerveSubsystem.periodic(): it took over 10 ms in 8 overrun loops (worst 39.4 ms). Move its slow work off the main loop or cache it.')
  })
})
