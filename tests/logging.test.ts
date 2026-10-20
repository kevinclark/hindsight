// The Logging tab (src/coverage/), the wanted checks (src/rules/wanted.ts) and auto/none-at-enable: made-up logs for
// each state and each branch of the rule, then the real logs when they are on this Mac (never copied into the repo).
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { coverage, coverageKeys, loggingChanges, neverLogged, worstAcross, type LoggedState } from '../src/coverage/coverage.ts'
import { profileKeys } from '../src/profiles/choose.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { offseason2025 } from '../src/profiles/2025-offseason.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { FORESIGHT_RULES, RULES } from '../src/rules/index.ts'
import { WANTED_CHECKS } from '../src/rules/wanted.ts'
import type { MatchSummary } from '../src/session/summary.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { CALGAMES, haveCalGames, readInput } from './helpers/load.ts'

type Entries = FixtureEntry[]

/** A robot log: enabled 20–50 s, auto 20–35 s, field attached from `fmsAt`, the chooser's records, and anything else. */
function robotLog(o: { fmsAt?: number | null; firstAuto?: boolean; chooser?: [number, string][]; volts?: [number, number][]; extra?: Entries } = {}): Entries {
  const fmsAt = o.fmsAt === undefined ? 12 : o.fmsAt
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false], [38, true], [50, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: o.firstAuto === false ? [[10, false]] : [[10, true], [35, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: fmsAt === null ? [[10, false]] : [[10, false], [fmsAt, true]] },
    { name: '/DriverStation/DSAttached', type: 'boolean', records: [[10, true]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: o.volts ?? [[10, 12.5], [50, 12.4]] },
    ...(o.chooser ? [{ name: '/NetworkInputs/SmartDashboard/Autos', type: 'string', records: o.chooser } as FixtureEntry] : []),
    ...(o.extra ?? []),
  ]
}

const analyze = (entries: Entries, profile = offseason2025) => analyzeFiles([{ name: 'm.wpilog', bytes: writeWpilog(entries) }], profile).analyses[0]
const findings = (entries: Entries) => analyze(entries).report.findings.filter((f) => f.rule === 'auto/none-at-enable')

describe('auto/none-at-enable', () => {
  it('fires when the first enable is auto on the field and the chooser reads None', () => {
    const odometry: FixtureEntry = { name: '/RealOutputs/Odometry/Robot', type: 'struct:Pose2d', records: [[20, { x: 1, y: 1, rot: 0 }], [30, { x: 1, y: 1, rot: 0 }]] }
    const [f] = findings(robotLog({ chooser: [[5, 'None']], extra: [odometry] }))
    expect(f.severity).toBe('warning')
    expect(f.title).toMatch(/No auto chosen: the auto chooser read "None" when auto started at 0:00 into the match/)
    expect(f.causes[0]).toMatchObject({ id: 'forgot', likely: true })
    expect(f.evidence['distance the robot drove in auto (m, from odometry)']).toBe(0)
  })
  it('says the auto was picked late when the chooser changed after the start', () => {
    const [f] = findings(robotLog({ chooser: [[5, 'None'], [24, 'Center auto']] }))
    expect(f.causes[0]).toMatchObject({ id: 'late', likely: true })
    expect(f.evidence['auto chooser picked later (robot time, s)']).toBe(24)
  })
  it('stays quiet when an auto was chosen', () => {
    expect(findings(robotLog({ chooser: [[5, 'None'], [14, 'Center auto']] }))).toEqual([])
  })
  it('stays quiet off the field (the chooser reads None in the pit all the time)', () => {
    expect(findings(robotLog({ fmsAt: null, chooser: [[5, 'None']] }))).toEqual([])
    expect(findings(robotLog({ fmsAt: 25, chooser: [[5, 'None']] }))).toEqual([])
  })
  it('stays quiet when the first enable is teleop (a restarted piece of a match)', () => {
    expect(findings(robotLog({ firstAuto: false, chooser: [[5, 'None']] }))).toEqual([])
  })
  it('says "not checked" when the chooser was first logged after auto started', () => {
    const a = analyze(robotLog({ chooser: [[22, 'None']] }))
    expect(a.report.findings.filter((f) => f.rule === 'auto/none-at-enable')).toEqual([])
    expect(a.report.skipped.find((s) => s.rule === 'auto/none-at-enable')?.reason).toBe('the auto chooser was first logged after auto started')
  })
  it('runs on match logs only, never in Foresight', () => {
    expect(RULES.some((r) => r.id === 'auto/none-at-enable')).toBe(true)
    expect(FORESIGHT_RULES.some((r) => r.id === 'auto/none-at-enable')).toBe(false)
  })
})

describe('coverageKeys', () => {
  it('starts from profileKeys: every key a profile names is on the list, for every built-in profile', () => {
    for (const p of PROFILES) {
      const listed = new Set(coverageKeys(p).map((k) => k.key))
      expect(profileKeys(p).filter((k) => !listed.has(k)), p.name).toEqual([])
    }
  })
  it('adds the slots profileKeys leaves out: battery, camera stale and result, other devices, zeroing, the chooser', () => {
    const keys = coverageKeys(offseason2026).map((k) => k.key)
    expect(keys).toContain('/RealOutputs/Battery/Id')
    expect(keys).toContain(offseason2026.cameras[0].stale)
    expect(keys).toContain(offseason2026.zeroing[0].position)
    expect(keys).toContain('/NetworkInputs/SmartDashboard/Autos')
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('coverage', () => {
  // 2026 robot: battery voltage at 10 Hz (slow), the gyro pitch frozen, accel X and Y never logged.
  const slowVolts: [number, number][] = Array.from({ length: 300 }, (_, i) => [20 + i * 0.1, 12 - (i % 7) * 0.05])
  const a = analyze(robotLog({
    chooser: [[5, 'Double Dip']],
    volts: slowVolts,
    extra: [
      { name: '/Swerve/Gyro/Pitch', type: 'double', records: [[10, 0.01]] },
      { name: '/Swerve/Gyro/Roll', type: 'double', records: [[10, 0], [30, 0.2]] },
    ],
  }), offseason2026)
  const cov = coverage(a.match, a.report)
  const line = (what: string) => cov.lines.find((l) => l.what === what)!

  it('marks a missing key "not logged" and names the check that went dark, with what it catches', () => {
    expect(line('accel x')).toMatchObject({ state: 'not logged', key: '/Swerve/Gyro/AXMetersPerSecondSq' })
    expect(line('accel x').dark.map((d) => d.rule)).toContain('collision/impact')
    expect(line('accel x').dark[0].incident).not.toBe('')
    expect(line('accel x').todo).toBe('Log accel x as /Swerve/Gyro/AXMetersPerSecondSq.')
  })
  it('still lists a missing key no check reached (a check stops at its first missing signal)', () => {
    expect(line('accel y')).toMatchObject({ state: 'not logged', dark: [] })
  })
  it('marks battery voltage "slow" below the 50 Hz bar, with the measured rate', () => {
    expect(line('battery voltage').state).toBe('slow')
    expect(line('battery voltage').measuredHz).toBeCloseTo(10, 0)
  })
  it('marks a signal that should move but sat at one value all log "never changes"', () => {
    expect(line('gyro pitch').state).toBe('never changes')
    expect(line('gyro roll').state).toBe('logged')
  })
  it('turns "the robot profile names no state machine" into a profile line, not a robot-code ask', () => {
    const gap = line('state machine')
    expect(gap).toMatchObject({ state: 'profile gap', key: null })
    expect(gap.dark.map((d) => d.rule)).toEqual(['mech/stuck-state'])
    expect(gap.todo).toMatch(/robot profile.*not a robot-code change/)
  })
  it('puts lines behind the checks that guard the match first', () => {
    const firstDark = cov.lines.findIndex((l) => l.dark.length === 0)
    expect(cov.lines.slice(firstDark).every((l) => l.dark.length === 0)).toBe(true)
  })
  it('never names a CTRE or AdvantageKit call in what to log', () => {
    const text = [...cov.lines.map((l) => l.todo), ...WANTED_CHECKS.flatMap((w) => [w.question, w.needs])].join('\n')
    expect(text).not.toMatch(/Logger\.|recordOutput|StatusSignal|getStatus|\.java|\(\)/)
  })
})

describe('wanted checks', () => {
  it('each names the incident and the signal needed, and has a unique id', () => {
    for (const w of WANTED_CHECKS) {
      expect(w.id).toMatch(/^wanted\//)
      expect(w.incident.length).toBeGreaterThan(10)
      expect(w.needs.length).toBeGreaterThan(10)
    }
    expect(new Set(WANTED_CHECKS.map((w) => w.id)).size).toBe(WANTED_CHECKS.length)
  })
  it('the USB stick is a live-only check, never a gap in a log', () => {
    expect(WANTED_CHECKS.find((w) => w.id === 'wanted/log-usb-stick')?.liveOnly).toMatch(/only a check of the robot in the pit/)
  })
  it('accel X/Y is a profile key, not a wanted check', () => {
    expect(WANTED_CHECKS.some((w) => /accel/i.test(w.question + w.needs))).toBe(false)
  })
})

describe('logging across a session', () => {
  const state = (key: string, s: LoggedState['state']): LoggedState => ({ what: key, key, state: s })
  const match = (label: string, sha: string, logging: LoggedState[]) => ({ matchLabel: label, fileName: label, build: { sha, branch: 'main', uncommitted: false }, logging }) as unknown as MatchSummary
  const ms = [
    match('Q13', 'aaaaaaa', [state('/AX', 'not logged'), state('/Id', 'not logged')]),
    match('Q21', 'bbbbbbb', [state('/AX', 'logged'), state('/Id', 'not logged')]),
    match('P0', 'bbbbbbb', [state('/AX', 'logged'), state('/Id', 'not logged')]),
  ]
  it('shows when a key appeared, by match and build', () => {
    const [c] = loggingChanges(ms)
    expect(c.key).toBe('/AX')
    expect(c.runs.map((r) => [r.state, r.first.matchLabel, r.last.matchLabel, r.matches])).toEqual([['not logged', 'Q13', 'Q13', 1], ['logged', 'Q21', 'P0', 2]])
  })
  it('lists keys missing from every match apart', () => {
    expect(neverLogged(ms).map((s) => s.key)).toEqual(['/Id'])
  })
  it('a match in several pieces keeps each key at its worst', () => {
    expect(worstAcross([[state('/A', 'logged')], [state('/A', 'slow')]])).toEqual([state('/A', 'slow')])
    expect(worstAcross([[state('/A', 'logged')], undefined])).toBeUndefined()
  })
})

const LOCAL = [`${homedir()}/Downloads/hindsight-test`]
const localLogs = LOCAL.filter(existsSync).flatMap((d) => readdirSync(d, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.wpilog')).map((f) => `${d}/${f}`))

describe.skipIf(!haveCalGames)('CalGames logs', () => {
  const analyses = haveCalGames ? analyzeFiles([CALGAMES.q13, CALGAMES.q21, CALGAMES.p0].map(readInput)).analyses : []
  const byName = (s: string) => analyses.find((a) => a.match.fileName.includes(s))!
  it('Q13 logs neither accel X nor Y; Q21 logs both (the proposal\'s laziness example)', () => {
    const q13 = coverage(byName('q13').match, byName('q13').report)
    expect(q13.lines.filter((l) => /^accel/.test(l.what)).map((l) => l.state)).toEqual(['not logged', 'not logged'])
    const q21 = coverage(byName('q21').match, byName('q21').report)
    expect(q21.lines.filter((l) => /^accel/.test(l.what)).map((l) => l.state)).toEqual(['logged', 'logged'])
  })
  it('none of the three fires auto/none-at-enable (the chooser was set 1.0–6.1 s after the field attached)', () => {
    expect(analyses.flatMap((a) => a.report.findings.filter((f) => f.rule === 'auto/none-at-enable'))).toEqual([])
  })
})

describe.skipIf(localLogs.length < 100)('backtest over every local log', () => {
  it('auto/none-at-enable fires on MTTD 2025 practice 5 only', () => {
    const fired = localLogs.filter((p) => {
      const a = analyzeFiles([readInput(p)]).analyses[0]
      return a?.report.findings.some((f) => f.rule === 'auto/none-at-enable')
    })
    expect(fired.map((p) => p.split('/').pop())).toEqual(['akit_25-11-07_19-38-15_p5.wpilog'])
  }, 120_000)
})
