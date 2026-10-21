// Plain WPILib logs (DataLogManager, no AdvantageKit): struct fields decoded by the log's own schema, the match
// identity from DS: and NT:/FMSInfo, and two other teams' robots. Every log here is synthetic, written in the same
// entry shapes as team 340's and team 3602's public 2026 logs (which carry no licence, so none of them is copied).
import { describe, expect, it } from 'vitest'
import { hasEntry, openWpilog, readNumbers, readValues } from '../src/readers/wpilog.ts'
import { analyze, analyzeFiles } from '../src/analyze.ts'
import { summarizeLog } from '../src/session/summary.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { frc340Daly2026 } from '../src/profiles/frc340-2026.ts'
import { frc3602_2026 } from '../src/profiles/frc3602-2026.ts'
import { packDoubles, writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const NT = { metadata: '{"properties":{},"source":"NT"}' }

describe('struct entries, decoded by the schema in the log', () => {
  const gyro = new DataView(new ArrayBuffer(26))
  gyro.setFloat64(0, 0.25, true) // pitch
  gyro.setUint8(8, 0b010) // faults: can_id_conflict only
  gyro.setInt8(9, -2) // mode
  gyro.setFloat64(10, 31.5, true) // temps[0]
  gyro.setFloat64(18, 32.5, true) // temps[1]
  const log = openWpilog(writeWpilog([
    { name: '/.schema/struct:Faults', type: 'structschema', records: [[0, 'bool power_cycle:1;bool can_id_conflict:1;bool hardware_fault:1']] },
    { name: '/.schema/struct:Gyro', type: 'structschema', records: [[0, 'double pitch; Faults faults; enum {a=1, b=2} int8 mode; double temps[2]']] },
    { name: 'NT:/.schema/struct:Motor', type: 'structschema', records: [[0, 'double supplyCurrent;double statorCurrent;double velocity;double deviceTemp']] },
    // The WPILib struct spec's bit-field example: a bool bit-field joins the int16 run before it (4 bytes, not 5).
    { name: '/.schema/struct:Packed', type: 'structschema', records: [[0, 'int16 a:4; uint16 b:5; bool c:1; int16 d:7']] },
    { name: '/gyro', type: 'struct:Gyro', records: [[1, new Uint8Array(gyro.buffer)]] },
    { name: 'NT:/Telemetry/hood/motor/', type: 'struct:Motor', records: [[1, packDoubles([8, 12, 2, 30])], [2, packDoubles([9, 15, 3, 31])]] },
    // a = 3, b = 17, c = true, d = 100: bits 0-3, 4-8, 9 of the first int16; d in the second.
    { name: '/packed', type: 'struct:Packed', records: [[1, new Uint8Array([0x13 | 0, (17 >> 4) | (1 << 1), 100, 0])]] },
    { name: '/mystery', type: 'struct:NoSchema', records: [[1, new Uint8Array([1, 2, 3])]] },
    { name: 'NT:/FMSInfo/FMSControlData', type: 'int64', records: [[1, 0x32], [2, 0x23]] },
    // A NetworkTables client stamps a record before its clock synced: a negative time, after later records in the file.
    { name: '/late', type: 'double', records: [[3, 1], [-0.5, 7]] },
  ]))

  it('reads a field by entry name + field, including an entry name that ends in "/"', () => {
    expect(Array.from(readNumbers(log, 'NT:/Telemetry/hood/motor/supplyCurrent')!.v)).toEqual([8, 9])
    expect(Array.from(readNumbers(log, 'NT:/Telemetry/hood/motor/deviceTemp')!.v)).toEqual([30, 31])
    expect(Array.from(readNumbers(log, 'NT:/Telemetry/hood/motor/supplyCurrent')!.t)).toEqual([1, 2])
    expect(hasEntry(log, 'NT:/Telemetry/hood/motor/statorCurrent')).toBe(true)
    expect(hasEntry(log, 'NT:/Telemetry/hood/motor/noSuchField')).toBe(false)
  })
  it('reads nested structs, bit-fields and enums; an array field is not a single number', () => {
    expect(readNumbers(log, '/gyro/pitch')!.v[0]).toBe(0.25)
    expect(readNumbers(log, '/gyro/faults/can_id_conflict')!.v[0]).toBe(1)
    expect(readNumbers(log, '/gyro/faults/power_cycle')!.v[0]).toBe(0)
    expect(readNumbers(log, '/gyro/mode')!.v[0]).toBe(-2)
    expect(readNumbers(log, '/gyro/temps')).toBeNull()
    expect(readValues(log, '/gyro')!.v[0]).toEqual({
      pitch: 0.25, faults: { power_cycle: 0, can_id_conflict: 1, hardware_fault: 0 }, mode: -2, temps: [31.5, 32.5],
    })
  })
  it('packs bit-fields as the WPILib struct spec does', () => {
    expect(readValues(log, '/packed')!.v[0]).toEqual({ a: 3, b: 17, c: 1, d: 100 })
  })
  it('reads one bit of an integer entry', () => {
    expect(Array.from(readNumbers(log, 'NT:/FMSInfo/FMSControlData:bit4')!.v)).toEqual([1, 0])
    expect(Array.from(readNumbers(log, 'NT:/FMSInfo/FMSControlData:bit5')!.v)).toEqual([1, 1])
  })
  it('leaves a struct with no schema as bytes', () => {
    expect(readValues(log, '/mystery')!.v[0]).toEqual(new Uint8Array([1, 2, 3]))
    expect(hasEntry(log, '/mystery/x')).toBe(false)
  })
  it('puts a record stamped before the log started first, and keeps it out of the log\'s extent', () => {
    expect(Array.from(readNumbers(log, '/late')!.t)).toEqual([-0.5, 3])
    expect(log.firstTime).toBe(0)
    expect(log.lastTime).toBe(3)
  })
})

/**
 * A match as DataLogManager logs it: auto enabled at 10 s, disabled at `autoEnd`, teleop 4 s later for 140 s (the
 * gap on 2026 fields), with the FMS attached and the match identity in NT:/FMSInfo.
 */
function dlmMatch(autoEnd = 30.5): FixtureEntry[] {
  const teleop = 34.5
  return [
    { name: 'DS:enabled', type: 'boolean', records: [[0, false], [10, true], [autoEnd, false], [teleop, true], [teleop + 140, false]] },
    { name: 'DS:autonomous', type: 'boolean', records: [[0, false], [9.5, true], [teleop, false]] },
    { name: 'NT:/FMSInfo/FMSControlData', type: 'int64', ...NT, records: [[0, 0], [9.5, 0x32], [10, 0x33], [autoEnd, 0x32], [teleop, 0x31], [teleop + 140, 0x30], [teleop + 160, 0]] },
    { name: 'NT:/FMSInfo/EventName', type: 'string', ...NT, records: [[0, ''], [5, 'TEST']] },
    { name: 'NT:/FMSInfo/MatchType', type: 'int64', ...NT, records: [[0, 0], [5, 2]] },
    { name: 'NT:/FMSInfo/MatchNumber', type: 'int64', ...NT, records: [[0, 0], [5, 7]] },
    { name: 'NT:/FMSInfo/ReplayNumber', type: 'int64', ...NT, records: [[0, 0], [5, 1]] },
    { name: 'systemTime', type: 'int64', records: [0, 5, 10, 15].map((t) => [t, 1_776_000_000e6 + t * 1e6]) },
    { name: 'NT:/SmartDashboard/Alerts/.type', type: 'string', metadata: '{"properties":{"SmartDashboard":"Alerts"},"source":"NT"}', records: [[0, 'Alerts']] },
    { name: 'NT:/SmartDashboard/Alerts/warnings', type: 'string[]', ...NT, records: [[0, []], [60, ['Intake jammed']], [61, []]] },
  ]
}

describe('match identity in a plain WPILib log', () => {
  it('comes from DS: and NT:/FMSInfo, whichever profile is used (here 8033\'s, which doesn\'t fit)', () => {
    const [a] = analyze([{ name: 'plain.wpilog', bytes: writeWpilog(dlmMatch()) }], offseason2026)
    const m = a.match
    expect(m.event).toBe('TEST')
    expect(m.matchLabel).toBe('Qualification 7')
    expect(m.fms).toBe(true)
    expect(m.matchStart).toBe(10)
    expect(m.teleopStart).toBe(34.5)
    expect(m.auto).toEqual([{ start: 10, end: 30.5 }])
    expect(m.epochOffset).toBe(1_776_000_000)
    // WPILib Alerts found by their NT .type, and passed through.
    expect(a.report.findings.some((f) => f.rule === 'alerts/passthrough' && f.title.includes('Intake jammed'))).toBe(true)
  })
  it("another team's plain log fits no profile (the keys every such log has don't count toward fit)", () => {
    const { analyses } = analyzeFiles([{ name: 'third.wpilog', bytes: writeWpilog(dlmMatch()) }])
    expect(analyses[0].match.profileChoice.misfit).toBe(true)
    expect(analyses[0].match.matchLabel).toBe('Qualification 7')
  })
  it('with no profile that fits, a full-length auto followed by the 2026 field\'s 4 s pause is not an early disable', () => {
    // Auto enabled 10 → 30.5 (20.5 s), teleop at 34.5: the misfit path measures auto from the log.
    const [a] = analyze([{ name: 'third.wpilog', bytes: writeWpilog(dlmMatch()) }], (() => undefined) as never)
    expect(a.match.profile.game.autoSeconds).toBe(21)
    expect(a.report.findings.filter((f) => f.rule === 'auto/early-disable')).toEqual([])
    // Cut short (disabled at 23.5 s, teleop 11 s later), auto is still teleop start less the pause, and it fires.
    const [cut] = analyze([{ name: 'cut.wpilog', bytes: writeWpilog(dlmMatch(23.5)) }], (() => undefined) as never)
    expect(cut.report.findings.some((f) => f.rule === 'auto/early-disable')).toBe(true)
  })
  it('a log with neither AdvantageKit /DriverStation nor DS: entries has no match', () => {
    const [a] = analyze([{ name: 'empty.wpilog', bytes: writeWpilog([{ name: '/x', type: 'double', records: [[1, 1], [2, 2]] }]) }], offseason2026)
    expect(a.match.matchStart).toBeNull()
    expect(a.match.matchLabel).toBe('')
  })
})

// A made-up field list in the same shape as a TalonFX status struct (the 340 profile reads these four fields).
const TALON_SCHEMA: FixtureEntry = {
  name: 'NT:/.schema/struct:TalonFX', type: 'structschema', ...NT,
  records: [[0, 'double supplyCurrent;double statorCurrent;double velocity;double deviceTemp']],
}
/** One TalonFX struct entry; each record is [time, supply A, velocity rot/s]. */
function talon(path: string, records: [number, number, number][]): FixtureEntry {
  return {
    name: `NT:/Telemetry/${path}/`, type: 'struct:TalonFX', ...NT,
    records: records.map(([t, supply, velocity]) => [t, packDoubles([supply, supply * 1.5, velocity, 30])]),
  }
}

/**
 * A log shaped like team 340's: every TalonFX in the DALY profile, drive motors pulling 45 A each through teleop (so
 * 180 A total heats the main breaker), the shooter leader at 50 Hz and its followers at 4 Hz.
 * The leader dips to 0 for 40 ms every 2 s, and a follower record lands in each dip: held for 0.25 s, that stale
 * value would look like a slipping follower if the rule compared it between records. `followerShare` sets how fast
 * the followers really spin, relative to the leader. With `slowLeaderSeconds` the leader is logged at 4 Hz too, and
 * runs at steady speed for only that long (no dips): few comparisons, but real seconds. `leaderHz` sets how often the
 * leader of such a short run is logged (the followers stay at 4 Hz).
 */
function team340Log(followerShare = 1, slowLeaderSeconds?: number, leaderHz = 4): Uint8Array {
  const teleop = 34.5
  const lead: [number, number, number][] = []
  const follow: [number, number, number][] = []
  if (slowLeaderSeconds === undefined) {
    for (let k = 0; k <= 7000; k++) {
      const t = teleop + k * 0.02
      const dip = k % 100 >= 50 && k % 100 < 52 // 40 ms at 1.0–1.04 s into every 2 s
      lead.push([+t.toFixed(3), 40, dip ? 0 : 60])
    }
    for (let k = 0; k <= 560; k++) {
      const t = teleop + 1.01 + k * 0.25 // every 8th record lands in a dip
      const dip = k % 8 === 0
      follow.push([+t.toFixed(3), 40, dip ? 0 : 60 * followerShare])
    }
  } else {
    const leadStep = 1 / leaderHz
    for (let k = 0; k * leadStep <= slowLeaderSeconds + 2; k++) {
      lead.push([+(teleop + 1 + k * leadStep).toFixed(3), 40, k * leadStep <= slowLeaderSeconds ? 60 : 0])
    }
    for (let k = 0; k <= 560; k++) {
      follow.push([+(teleop + 0.99 + k * 0.25).toFixed(3), 40, k * 0.25 <= slowLeaderSeconds ? 60 * followerShare : 0])
    }
  }
  const still = (path: string) => talon(path, [[5, 0, 0]])
  return writeWpilog([
    ...dlmMatch(),
    TALON_SCHEMA,
    ...['frontLeft', 'frontRight', 'backLeft', 'backRight'].flatMap((m) => [
      talon(`swerve/api/hardware/${m}/moveMotor`, [[5, 0, 0], [teleop, 45, 80], [teleop + 140, 0, 0]]),
      still(`swerve/api/hardware/${m}/turnMotor`),
    ]),
    talon('shooter/portLowerLead', lead),
    ...['portUpperFollow', 'starboardLowerFollow', 'starboardUpperFollow'].map((f) => talon(`shooter/${f}`, follow)),
    ...['hood/motor', 'indexer/portUpperLead', 'indexer/portLowerFollow', 'indexer/starboardLowerLead', 'indexer/starboardUpperFollow', 'intake/pivot', 'intake/rollersLead', 'intake/rollersFollow'].map(still),
  ])
}

describe("a team-340-shaped log: TalonFX structs, no battery voltage", () => {
  const { analyses } = analyzeFiles([{ name: '340.wpilog', bytes: team340Log() }])
  const a = analyses[0]
  const fired = (id: string) => a.report.findings.filter((f) => f.rule === id)
  const skipped = (id: string) => a.report.skipped.find((s) => s.rule === id)?.reason ?? ''

  it('is matched to the 340 profile by its signals', () => {
    expect(a.match.profile.name).toBe(frc340Daly2026.name)
    expect(a.match.profileChoice.how).toBe('signals')
    expect(a.match.profileChoice.misfit).toBe(false)
    expect(a.match.matchLabel).toBe('Qualification 7')
  })
  it('sums the struct supply currents for the main breaker, with no battery voltage', () => {
    const [f] = fired('power/main-breaker-margin')
    expect(f).toBeDefined()
    expect(f.evidence['carried most of it']).toMatch(/^Drive/)
    // Followers logged at 4 Hz are named on the finding.
    expect(f.evidence['logged slowly (short dips or spikes can be missed)']).toMatch(/follower supply are logged about 4 times a second/)
    expect(f.plot?.unit).toBe('A')
  })
  it('does not mistake a stale 4 Hz follower for a slipping one', () => {
    expect(fired('mech/follower-mismatch')).toEqual([])
  })
  it('still catches a follower that really runs slow at 4 Hz', () => {
    const slow = analyze([{ name: '340-slip.wpilog', bytes: team340Log(0.7) }])[0]
    const f = slow.report.findings.find((x) => x.rule === 'mech/follower-mismatch')
    expect(f?.title).toMatch(/follower ran more than 15 % off .* \(median 70 %\)/)
  })
  it('measures a slowly logged leader by steady seconds, not by a comparison count (rule and Trends agree)', () => {
    // 5 s of steady running at 4 Hz: about 20 comparisons (under 50), each standing for 0.25 s.
    const file = { name: '340-slow-leader.wpilog', bytes: team340Log(0.7, 5) }
    const rule = analyze([file])[0].report.findings.find((x) => x.rule === 'mech/follower-mismatch')
    expect(rule).toBeDefined()
    const trends = summarizeLog(file)!.metrics.followerSecondsOff
    expect(trends).not.toBeNull()
    expect(trends!).toBeCloseTo(rule!.measured![0].value, 1)
    // A fast leader steady for 0.8 s, followers at 4 Hz counting 1.0 s off: the rule fires on the followers' seconds, so Trends reports it too.
    const brief = { name: '340-brief.wpilog', bytes: team340Log(0.7, 1.3, 50) }
    expect(analyze([brief])[0].report.findings.some((x) => x.rule === 'mech/follower-mismatch')).toBe(true)
    expect(summarizeLog(brief)!.metrics.followerSecondsOff).toBeGreaterThanOrEqual(1)
    // Under a second of steady running is still "not measured".
    expect(summarizeLog({ name: '340-short.wpilog', bytes: team340Log(0.7, 0.5) })!.metrics.followerSecondsOff).toBeNull()
  })
  it('says what it could not check, and why', () => {
    expect(skipped('power/limit-not-applied')).toMatch(/no current limits for Drive \(not read from 340's robot code\)/)
    expect(skipped('power/battery-collapse')).toBe('missing battery voltage (the robot profile has no key for it)')
    expect(skipped('power/brownout')).toBe("missing browned out (only a Driver Station log has it: load this match's .dslog)")
  })
})

/** A log shaped like team 3602's: the dashboard's battery voltage at 15 Hz, resting at 12.2 V; auto cut off at 23.5 s. */
function team3602Log(): Uint8Array {
  const volts: [number, number][] = []
  for (let t = 0; t < 180; t += 1 / 15) volts.push([+t.toFixed(4), t < 10 ? 12.2 + (Math.round(t * 15) % 2) * 0.01 : 11 + (Math.round(t * 15) % 7) * 0.05])
  return writeWpilog([
    ...dlmMatch(23.5),
    { name: 'NT:/Elastic/Status/BatteryVoltage', type: 'double', ...NT, records: volts },
  ])
}

describe("a team-3602-shaped log: dashboard battery voltage at 15 Hz, no motor currents", () => {
  const [a] = analyze([{ name: '3602.wpilog', bytes: team3602Log() }], frc3602_2026)
  const find = (id: string) => a.report.findings.find((f) => f.rule === id)

  it('checks the rest voltage, and says the voltage is logged slowly', () => {
    const f = find('power/rest-voltage')
    expect(f?.title).toMatch(/rested at 12\.2\d? V/)
    expect(f?.evidence['logged slowly (short dips or spikes can be missed)']).toMatch(/battery voltage is logged about 15 times a second while enabled \(every ~67 ms\)/)
  })
  it('finds the early disable in auto from DS: and FMSControlData', () => {
    expect(find('auto/early-disable')?.title).toMatch(/with 6\.5 s of auto left/)
  })
  it('leaves the current rules unchecked rather than summing no motors', () => {
    expect(a.report.skipped.find((s) => s.rule === 'power/main-breaker-margin')?.reason).toBe('missing motor supply currents')
  })
})
