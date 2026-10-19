// Foresight's checks on made-up robots (a "badness" log each), run through the real engine, plus the proof that
// the keys Foresight subscribes to are enough: on the CalGames logs, the subscribed keys give the same findings as
// the whole log.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { openWpilog, readNumbers } from '../src/readers/wpilog.ts'
import { RecordStore } from '../src/foresight/records.ts'
import { evaluateForesight, SETTLE_SECONDS, type ForesightResult } from '../src/foresight/engine.ts'
import { foresightKeys } from '../src/foresight/keys.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { CALGAMES, haveCalGames } from './helpers/load.ts'

const START = 10
const NOW = 100
const steady = (value: number | boolean | string) => [[START, value]] as [number, number | boolean | string][]

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
  ]
}

/** The healthy robot with some entries replaced. */
function robot(changes: FixtureEntry[]): Uint8Array {
  const byName = new Map<string, FixtureEntry>()
  for (const e of [...healthy(), ...changes]) byName.set(e.name, e)
  return writeWpilog([...byName.values()])
}

function check(changes: FixtureEntry[], lastPassingSha: string | null = null): Extract<ForesightResult, { state: 'checked' }> {
  const store = RecordStore.fromWpilog(openWpilog(robot(changes)), null)
  const r = evaluateForesight({ store, codeStart: START, now: NOW, lastPassingSha, profile: offseason2026 })
  if (r.state !== 'checked') throw new Error(`not checked: ${r.state}`)
  return r
}
const rules = (r: ReturnType<typeof check>, level?: string) => r.verdict.items.filter((i) => !level || i.level === level).map((i) => i.finding.rule)
/** Amber or red: what moves the pit crew. */
const flagged = (r: ReturnType<typeof check>) => r.verdict.items.filter((i) => i.level !== 'grey').map((i) => i.finding.rule)

describe('Foresight checks on a robot in the pit', () => {
  it('a healthy robot: GO, nothing flagged, gyro drift as grey context', () => {
    const r = check([])
    expect(r.verdict.verdict).toBe('GO')
    expect(flagged(r)).toEqual([])
    expect(rules(r, 'grey')).toEqual(['foresight/gyro-still-drift'])
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
    // Proven on the backtest, so red and NO-GO, with the proof shown.
    expect(r.verdict.items[0].level).toBe('red')
    expect(r.verdict.verdict).toBe('NO-GO')
    expect(r.verdict.items[0].proof).toMatch(/^proven on 3 match logs, never fired there/)
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
    expect(f.evidence['likely cause']).toMatch(/not known/)
    expect(f.causes.find((c) => c.id === 'battery-sag')?.ruledOut).toBeUndefined()
  })

  it('zero sanity waits while the mechanism is being moved', () => {
    const r = check([{ name: '/Intake/Pivot/PositionRotations', type: 'double', records: [[START, 0.3677], [99, 0.3677 + 5 / 360], [99.5, 0.6536]] }])
    expect(flagged(r)).toEqual([])
    expect(r.report.skipped.find((s) => s.rule === 'foresight/zero-sanity')?.reason).toMatch(/Intake pivot not checked: it is moving/)
  })
})

describe('Foresight verdict', () => {
  const finding = (rule: string, severity: 'error' | 'warning' | 'info') => ({ rule, severity, title: rule, time: null, matchTime: null, when: null, about: null, key: rule, evidence: {}, meaning: '', causes: [], nextStep: `do ${rule}` })
  const proven = { 'power/rest-voltage': { logs: 3, fires: 1, base: 'CalGames 2026', date: '2026-10-19' } }
  it('amber unless proven; red only for proven checks; NO-GO on any red', () => {
    const v = verdictFor({ findings: [finding('build/dirty', 'warning'), finding('power/rest-voltage', 'warning'), finding('x', 'info')], skipped: [], crashed: [] }, proven)
    expect(v.verdict).toBe('NO-GO')
    expect(v.items.map((i) => [i.finding.rule, i.level])).toEqual([['power/rest-voltage', 'red'], ['build/dirty', 'amber'], ['x', 'grey']])
    expect(v.items[0].proof).toMatch(/proven on 3 match logs, fired on 1, all real/)
    expect(v.items[0].action).toBe('do power/rest-voltage')
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
      const subscribed = summary(RecordStore.fromWpilog(log, foresightKeys(offseason2026)))
      const whole = summary(RecordStore.fromWpilog(log, null))
      expect(subscribed).toEqual(whole)
      expect(foresightKeys(offseason2026).length).toBeLessThan(80)
    })
  }
})
