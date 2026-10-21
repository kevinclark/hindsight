// The Driver Station's event log (.dsevents): its brownout count, the FMS's match identity and the roboRIO's kernel
// USB lines, as signals from another log. Every file here is synthetic, in the shapes seen in team 334's public 2026
// event logs (which carry no licence, so none of them is copied).
import { describe, expect, it } from 'vitest'
import { analyze } from '../src/analyze.ts'
import { kernelLines, readDsevents } from '../src/readers/dsevents.ts'
import { frc334_2026 } from '../src/profiles/frc334-2026.ts'
import { writeDsevents, writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const EPOCH = 1_776_000_000
const AUTO = 10
const TELEOP = 34
const END = TELEOP + 140
/** roboRIO uptime minus robot time in this boot (334's E6: 38 s). */
const UPTIME_AHEAD = 38

/** A plain WPILib match with no NetworkTables capture: no match identity, battery voltage only. */
function robotLog(): FixtureEntry[] {
  const volts: [number, number][] = []
  for (let t = 0; t < END + 5; t += 0.02) volts.push([+t.toFixed(2), t > 80 && t < 81 ? 7.5 : 12.4])
  return [
    { name: 'DS:enabled', type: 'boolean', records: [[0, false], [AUTO, true], [AUTO + 20, false], [TELEOP, true], [END, false]] },
    { name: 'DS:autonomous', type: 'boolean', records: [[0, false], [AUTO, true], [TELEOP, false]] },
    { name: 'systemTime', type: 'int64', records: [0, 5, 10, 15].map((t) => [t, (EPOCH + t) * 1e6]) },
    { name: '/Robot/SystemStats/BatteryVoltage', type: 'double', records: volts },
    { name: '/Robot/SystemStats/BrownedOut', type: 'boolean', records: [[0, false], [100, true], [100.1, false], [120, true], [120.1, false]] },
    { name: '/Robot/DogLog/Options', type: 'string', records: [[0, 'DogLogOptions[captureDs=true]']] },
  ]
}

const kernel = (robotTime: number, text: string) => `<TagVersion>1 <time> 00:00.000 <message> [  ${(robotTime + UPTIME_AHEAD).toFixed(6)}] ${text} `

/** A DS event log: the FMS line, a USB drop of the CANivore's port at 82 s (sent twice), and the brownout count. */
function eventLog(): Uint8Array {
  const at = (robotTime: number) => EPOCH + robotTime
  return writeDsevents(EPOCH - 5, [
    [EPOCH - 5, 'FMS Connected:   Elimination - 6:1, Field Time: 26/4/8 19:0:52\n -- FRC Driver Station - Version 26.0'],
    // An earlier boot's line (uptime 5 s), logged before this robot log started: not this match's.
    [EPOCH - 4, '<TagVersion>1 <time> 00:00.000 <message> [    5.000000] usb 1-1.2.4: USB disconnect, device number 7 '],
    [at(82.3), kernel(82, 'canivore_usb 1-1.2.4:1.1 can1: usb tx fail 1') + kernel(82.001, 'usb 1-1.2.4: USB disconnect, device number 9')],
    [at(83.4), kernel(82.001, 'usb 1-1.2.4: USB disconnect, device number 9') + kernel(82.5, 'usb 1-1.2-port4: disabled by hub (EMI?), re-enabling...')],
    [at(101), 'Info Communications Timeout: 0 Input Voltage Brownouts: 1. '],
    [at(121), 'Info Communications Timeout: 0 Input Voltage Brownouts: 2. '],
  ])
}

const files = () => [{ name: 'match.wpilog', bytes: writeWpilog(robotLog()) }, { name: 'match.dsevents', bytes: eventLog() }]

describe('reading a .dsevents', () => {
  it('splits records into messages and counts each kernel line once', () => {
    const file = readDsevents(eventLog())
    const disconnects = kernelLines(file).filter((l) => /USB disconnect/.test(l.text))
    expect(disconnects.map((l) => l.uptime)).toEqual([5, 120.001])
    expect(disconnects[1].epochSeconds).toBeCloseTo(EPOCH + 82.3, 3) // the first time the DS logged it
  })
})

describe('the Driver Station event log as a source', () => {
  const [a] = analyze(files(), frc334_2026)
  const find = (id: string) => a.report.findings.find((f) => f.rule === id)

  it('gives the match identity the robot log lacks', () => {
    expect(a.match.matchLabel).toBe('Elimination 6')
  })
  it("puts the DS's own count beside the robot log's", () => {
    const f = find('power/brownout')
    expect(f?.title).toMatch(/^Browned out 2 times/)
    expect(f?.evidence['the Driver Station counted (this log)']).toBe(2)
    expect(f?.evidence['read from']).toMatch(/Driver Station brownout count: the Driver Station's event log/)
  })
  it('finds the CANivore dropping off USB once, on the robot clock, from its uptime', () => {
    const f = find('can/usb-dropout')
    // At 82.0 s; the DS logged every line 0.3 s late, and with none logged sooner that lag can't be told apart.
    expect(f?.title).toMatch(/^CANivore dropped off USB 1 time, first .*robot time 82\.3 s/)
    expect(f?.evidence['failed USB sends (kernel "usb tx fail")']).toBe(1)
    expect(f?.evidence['times the hub disabled the port (kernel "disabled by hub")']).toBe(1)
    expect(f?.causes[0]).toMatchObject({ id: 'hub', likely: true })
    expect(f?.evidence['lowest battery voltage in the 6 s before each (V)']).toBe('7.5')
  })
  it('without a .dsevents, says which file to load', () => {
    const [alone] = analyze([files()[0]], frc334_2026)
    expect(alone.match.matchLabel).toBe('')
    expect(alone.report.skipped.find((s) => s.rule === 'can/usb-dropout')?.reason)
      .toBe("missing canivore usb disconnects (only a Driver Station event log has it: load this match's .dsevents)")
    expect(alone.report.findings.find((f) => f.rule === 'power/brownout')?.evidence['the Driver Station counted (this log)']).toBeUndefined()
  })
})

describe('the event log across a DS session longer than this robot log', () => {
  const at = (robotTime: number) => EPOCH + robotTime
  // Before this log: practice brownouts counted to 5, and another match's FMS line. During it: an earlier boot's lines
  // re-sent at 82.3 s (uptime 900 s, a far smaller gap), beside this boot's one drop.
  const session = () => writeDsevents(EPOCH - 600, [
    [EPOCH - 600, 'FMS Connected:   Qualification - 25:1, Field Time: 26/4/8 18:50:0'],
    [EPOCH - 300, 'Info Communications Timeout: 0 Input Voltage Brownouts: 5. '],
    [EPOCH - 5, 'FMS Connected:   Qualification - 26:1, Field Time: 26/4/8 19:0:0'],
    [at(82.3), kernel(82.001, 'usb 1-1.2.4: USB disconnect, device number 9') + kernel(82, 'canivore_usb 1-1.2.4:1.1 can1: usb tx fail 1')],
    [at(82.3), `<TagVersion>1 <time> 00:00.000 <message> [  900.000000] usb 1-1.2.4: USB disconnect, device number 3 `],
    [at(101), 'Info Communications Timeout: 0 Input Voltage Brownouts: 6. '],
    [at(121), 'Info Communications Timeout: 0 Input Voltage Brownouts: 7. '],
  ])
  const [a] = analyze([files()[0], { name: 'session.dsevents', bytes: session() }], frc334_2026)

  it("takes the FMS's last word before the log ended", () => {
    expect(a.match.matchLabel).toBe('Qualification 26')
  })
  it("counts the DS's brownouts from the log's start", () => {
    expect(a.report.findings.find((f) => f.rule === 'power/brownout')?.evidence['the Driver Station counted (this log)']).toBe(2)
  })
  it("keeps this boot's clock when another boot's line is re-sent", () => {
    const f = a.report.findings.find((x) => x.rule === 'can/usb-dropout')
    expect(f?.title).toMatch(/^CANivore dropped off USB 1 time, first .*robot time 82\.3 s/)
  })
})
