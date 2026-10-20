// DogLog logs (the roboRIO's readings and a REV PDH under /Robot/SystemStats), the PDH's total current as the robot's
// current when no motor currents are logged, and brownouts from the Driver Station log when the robot log has no
// flag. Every log here is synthetic, written in the same entry shapes as team 334's public 2026 logs (which carry no
// licence, so none of them is copied).
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze.ts'
import { buildPowerGrid } from '../src/power/battery-model.ts'
import { frc334_2026 } from '../src/profiles/frc334-2026.ts'
import { writeDslog, writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const PD = '/Robot/SystemStats/PowerDistribution'
const EPOCH = 1_776_000_000
const AUTO = 10
const TELEOP = 34
const END = TELEOP + 140
const OHMS = 0.018

/** The robot's real current: 20 A, with a 220 A burst for 0.3 s of every 0.6 s through teleop. */
const amps = (t: number) => (t >= TELEOP && t < END && (t - TELEOP) % 0.6 < 0.3 ? 220 : 20)

/**
 * A match as DogLog logs it: battery voltage every 20 ms, V = 12.5 − 18 mΩ·I; the PDH's total every 80 ms,
 * stamped `lateSeconds` after the current it measured; three brownouts in teleop.
 */
function dogLogMatch(lateSeconds = 0.12): FixtureEntry[] {
  const volts: [number, number][] = []
  for (let k = 0; k * 0.02 < END + 5; k++) { const t = +(k * 0.02).toFixed(2); volts.push([t, 12.5 - OHMS * amps(t)]) }
  const total: [number, number][] = []
  for (let k = 0; k * 0.08 < END + 5; k++) { const t = +(k * 0.08).toFixed(2); total.push([+(t + lateSeconds).toFixed(2), amps(t)]) }
  return [
    { name: 'DS:enabled', type: 'boolean', records: [[0, false], [AUTO, true], [AUTO + 20, false], [TELEOP, true], [END, false]] },
    { name: 'DS:autonomous', type: 'boolean', records: [[0, false], [AUTO, true], [TELEOP, false]] },
    { name: 'systemTime', type: 'int64', records: [0, 5, 10, 15].map((t) => [t, (EPOCH + t) * 1e6]) },
    { name: '/Robot/SystemStats/BatteryVoltage', type: 'double', records: volts },
    { name: '/Robot/SystemStats/BrownedOut', type: 'boolean', records: [[0, false], [60, true], [60.1, false], [90, true], [90.2, false], [120, true], [120.1, false]] },
    { name: '/Robot/SystemStats/BrownoutVoltage', type: 'double', records: [[0, 6.75]] },
    { name: `${PD}/TotalCurrent`, type: 'double', records: total },
    { name: `${PD}/ChannelCurrent`, type: 'double[]', records: total.map(([t, a]) => [t, [a / 2, a / 2, ...Array(22).fill(0)] as never]) },
    { name: `${PD}/Voltage`, type: 'double', records: [[0, 12.5]] },
    { name: `${PD}/ChannelCount`, type: 'int64', records: [[0, 24]] },
  ]
}

describe('a team-334-shaped log: DogLog system stats and a REV PDH, no motor currents', () => {
  const [a] = analyze([{ name: '334.wpilog', bytes: writeWpilog(dogLogMatch()) }])
  const find = (id: string) => a.report.findings.find((f) => f.rule === id)
  const skipped = (id: string) => a.report.skipped.find((s) => s.rule === id)?.reason

  it('is matched to the 334 profile by its signals, and lines up with the wall clock through systemTime', () => {
    expect(a.match.profile.name).toBe(frc334_2026.name)
    expect(a.match.profileChoice.how).toBe('signals')
    expect(a.match.epochOffset).toBe(EPOCH)
  })
  it('counts the brownouts from the robot log, with the PDH total as the current', () => {
    const f = find('power/brownout')
    expect(f?.title).toMatch(/^Browned out 3 times/)
    expect(f?.evidence['total current at the first brownout (A)']).toBeDefined()
    expect(f?.evidence['brownouts counted from']).toBeUndefined()
  })
  it('lines the late PDH total up with the voltage before measuring resistance', () => {
    const grid = buildPowerGrid(a.match)!
    // 0.12 s late, plus up to one 80 ms sample held: the step that lines up best is the one to use.
    expect(grid.totalCurrentShift).toBeGreaterThanOrEqual(0.12)
    expect(grid.totalCurrentShift).toBeLessThan(0.12 + 0.08)
    expect(skipped('power/wiring-resistance')).toMatch(/^partly checked; total current is logged about 1[23] times a second/)
    expect(find('power/wiring-resistance')).toBeUndefined() // 18 mΩ is under 20
    const resistance = find('power/brownout')!.evidence['battery + wiring resistance (mΩ)'] as number
    // 18 mΩ really; the total's 80 ms samples blur the 0.3 s bursts, so it reads a little low.
    expect(resistance).toBeGreaterThan(15)
    expect(resistance).toBeLessThan(19)
  })
  it('moves the total less than one sample when it is logged on time', () => {
    const [onTime] = analyze([{ name: '334.wpilog', bytes: writeWpilog(dogLogMatch(0)) }])
    expect(buildPowerGrid(onTime.match)!.totalCurrentShift).toBeLessThan(0.08)
  })
  it('checks the PDH under its DogLog folder', () => {
    expect(skipped('power/pd-not-reporting')).toBeUndefined()
  })
})

describe('brownouts from the Driver Station log, when the robot log has no flag', () => {
  // The DS log starts 1 s into the robot log (epoch EPOCH + 1): its record i is at robot time 1 + 0.02·i.
  const record = (t: number) => Math.round((t - 1) / 0.02)
  const dslog = writeDslog({
    name: 'match.dslog', startEpochSeconds: EPOCH + 1, count: record(END + 2), robotFrom: 0, noRobotFrom: record(END + 2),
    brownouts: [[record(60), record(60.1)], [record(90), record(90.2)]],
  })
  const noFlag = { ...frc334_2026, signals: { ...frc334_2026.signals, brownedOut: '' } }
  const files = [{ name: '334.wpilog', bytes: writeWpilog(dogLogMatch()) }, { name: 'match.dslog', bytes: dslog }]

  it('counts them from the DS log, on the robot clock, and says so', () => {
    const [a] = analyze(files, noFlag)
    const f = a.report.findings.find((x) => x.rule === 'power/brownout')
    expect(f?.title).toMatch(/^Browned out 2 times, first .*robot time 60\.0 s/)
    expect(f?.evidence['brownouts counted from']).toMatch(/Driver Station log/)
  })
  it('without a DS log, says the flag is missing', () => {
    const [a] = analyze([files[0]], noFlag)
    expect(a.report.skipped.find((s) => s.rule === 'power/brownout')?.reason).toBe('missing browned out (the robot profile has no key for it)')
  })
  it('the robot log\'s flag wins when it has one', () => {
    const [a] = analyze(files, frc334_2026)
    expect(a.report.findings.find((x) => x.rule === 'power/brownout')?.title).toMatch(/^Browned out 3 times/)
  })
})
