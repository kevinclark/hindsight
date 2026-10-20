// power/main-breaker-margin and power/pd-not-reporting on synthetic logs.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { writeWpilog } from './helpers/fixture-format.ts'

type Entries = Parameters<typeof writeWpilog>[0]
const modules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']
// Enabled from 10 s to 410 s, with every drive motor at `amps` the whole time.
const pushing = (amps: number): Entries => [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [410, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [10, 11], [410, 12.3], [420, 12.3]] },
  ...modules.map((m) => ({ name: `/Swerve/${m} Module/DriveSupplyCurrentAmps`, type: 'double', records: [[0, 0], [10, amps], [410, 0], [420, 0]] })),
] as Entries
const run = (entries: Entries) => analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0].report

describe('power/main-breaker-margin', () => {
  it('fires when four drive motors are held at 40 A for minutes (160 A, a long push)', () => {
    const f = run(pushing(40)).findings.find((x) => x.rule === 'power/main-breaker-margin')
    // 4 × 40 A + 3 A other = 163 A, 136 % of 120 A once the breaker has heated: above the band, so red.
    expect(f?.severity).toBe('error')
    expect(f?.measured?.[0].value).toBeGreaterThan(130)
  })
  it('stays quiet at 25 A per motor (103 A total)', () => {
    expect(run(pushing(25)).findings.some((x) => x.rule === 'power/main-breaker-margin')).toBe(false)
  })
})

describe('power/pd-not-reporting', () => {
  const board = (channels: number[][]): Entries => [
    { name: '/PowerDistribution/ChannelCount', type: 'int64', records: [[1, channels[0].length]] },
    { name: '/PowerDistribution/ChannelCurrent', type: 'double[]', records: channels.map((c, i) => [1 + i, c]) },
    { name: '/PowerDistribution/Voltage', type: 'double', records: [[1, 0]] },
  ] as Entries
  const pd = (entries: Entries, profile = offseason2026) =>
    analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], profile).analyses[0].report.findings.find((x) => x.rule === 'power/pd-not-reporting')
  it('warns when a board that can report (a REV PDH) logged once, all zero, while the motors drew current', () => {
    const f = pd([...pushing(30), ...board([new Array(24).fill(0)])], { ...offseason2026, powerDistribution: 'rev-pdh' })
    expect(f?.severity).toBe('warning')
    expect(f?.title).toMatch(/claims a REV Power Distribution Hub/)
  })
  it('is context when the board can\'t report (a CTRE PDP 2.0): Hindsight uses the motor currents instead', () => {
    const f = pd([...pushing(30), ...board([new Array(24).fill(0)])])
    expect(f?.severity).toBe('info')
    expect(f?.title).toMatch(/PDP 2\.0\) doesn't report/)
  })
  it('warns when the board is unknown but the log claims a CTRE PDP (16 channels), a board that reports', () => {
    const f = pd([...pushing(30), ...board([new Array(16).fill(0)])], { ...offseason2026, powerDistribution: undefined })
    expect(f?.severity).toBe('warning')
  })
  it('doesn\'t fire when the channels report but the board voltage isn\'t logged', () => {
    const entries = [...pushing(30), ...board([[10, 12, 9], [11, 13, 8], [12, 11, 10]]).filter((e) => e.name !== '/PowerDistribution/Voltage')]
    expect(pd(entries, { ...offseason2026, powerDistribution: 'rev-pdh' })).toBeUndefined()
  })
  it('is not checked when the log has no power distribution entries', () => {
    expect(run(pushing(30)).skipped.find((s) => s.rule === 'power/pd-not-reporting')?.reason).toMatch(/no \/PowerDistribution/)
  })
})

describe('motor currents after a controller drops off CAN', () => {
  // Two drive motors draw 80 A from 10 s and log no more currents. The front left's Connected flag goes false at 50 s;
  // the back left has no Connected flag in the log at all.
  const entries: Entries = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [110, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [120, 12.3]] },
    { name: '/Swerve/Front Left Module/DriveSupplyCurrentAmps', type: 'double', records: [[0, 0], [10, 80]] },
    { name: '/Swerve/Back Left Module/DriveSupplyCurrentAmps', type: 'double', records: [[0, 0], [10, 80]] },
    { name: '/Swerve/Front Left Module/DriveConnected', type: 'boolean', records: [[0, true], [50, false]] },
  ] as Entries
  const motorAmps = async (name: string, at: number) => {
    const { buildPowerGrid } = await import('../src/power/battery-model.ts')
    const match = analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], offseason2026).analyses[0].match
    const grid = buildPowerGrid(match)!
    return grid.motors.find((m) => m.name === name)!.amps[grid.t.findIndex((x) => x >= at)]
  }
  it('reads 80 A while connected and 0 A once Connected is false', async () => {
    expect(await motorAmps('Front Left drive', 30)).toBe(80)
    expect(await motorAmps('Front Left drive', 60)).toBe(0)
    expect(await motorAmps('Front Left drive', 119)).toBe(0)
  })
  it('a motor with no Connected flag in the log keeps its held value', async () => {
    expect(await motorAmps('Back Left drive', 119)).toBe(80)
  })
})

describe('power/main-breaker-margin: the peak is inside the match', () => {
  it('a current held after the match ended is not the match\'s peak', () => {
    // Four drives at 60 A to 260 s (the match), then no more records and no Connected flag: held to the end of the log.
    // Heating peaks at the end of the match; the hold would keep climbing after it.
    const entries = [
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [260, false]] },
      { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [700, 12.3]] },
      ...modules.map((m) => ({ name: `/Swerve/${m} Module/DriveSupplyCurrentAmps`, type: 'double', records: [[0, 0], [10, 60]] })),
    ] as Entries
    const f = run(entries).findings.find((x) => x.rule === 'power/main-breaker-margin')
    expect(f?.time).toBeLessThanOrEqual(260)
  })
})
