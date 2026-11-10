// Unlock lines (src/coverage/unlock.ts): every skip-reason producer's real text lands where it should, rules are
// listed once per kind, groups come worst first, and no reason a real analysis gives goes unplaced. Invented logs only.
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { gapIn, parts } from '../src/coverage/coverage.ts'
import { DS_FILES_FIX, placePart, sessionUnlocks, unlockFix, unlockKey, unlockWords, unlocks, type Unlock } from '../src/coverage/unlock.ts'
import { offseason2025 } from '../src/profiles/2025-offseason.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { RULES } from '../src/rules/index.ts'
import { NO_PROFILE_FITS, NO_WATCHED_DEVICE, PROFILE_DOESNT_FIT } from '../src/rules/run.ts'
import { NO_KEY, onlyIn } from '../src/rules/view.ts'
import { NO_HOOT } from '../src/rules/can/device-fault.ts'
import type { MatchSummary } from '../src/session/summary.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'

const file = (f: string) => ({ unlock: { kind: 'file', file: f } })

describe('placePart', () => {
  it('places a file only another log has, from onlyIn()', () => {
    expect(placePart(`missing Brownout (${onlyIn('dslog:brownout')})`)).toEqual(file('.dslog'))
    expect(placePart(`missing USB drops (${onlyIn('dsevents:usbDropouts')})`)).toEqual(file('.dsevents'))
  })

  it('places comms/ds-log-truncated\'s own text as a .dslog', () => {
    expect(placePart('no .dslog loaded for this match (drop the .dslog together with the .wpilog)')).toEqual(file('.dslog'))
  })

  it('places can/device-fault\'s "no .hoot" as a .hoot, but not a reason about a .hoot it did read', () => {
    expect(placePart(NO_HOOT)).toEqual(file('.hoot'))
    expect(placePart('ABC_2026-03-14_20-14-20.hoot: not lined up with this log (the .hoot never saw the robot enabled)')).toHaveProperty('other')
    expect(placePart('the .hoot files read hold no CTRE device (rio_2026-03-14_20-14-20.hoot)')).toHaveProperty('other')
  })

  it('places every kind of profile gap as the profile', () => {
    const gaps = [
      `missing Gyro (${NO_KEY})`, 'missing Gyro (not in the robot profile)', 'missing Gyro (the robot profile has none)',
      'the robot profile has no motor group this rule is for', 'the robot profile lists no cameras', 'the robot profile names no state machine',
      `${NO_PROFILE_FITS} (the closest has 3 of its 40 signals in it)`, `${PROFILE_DOESNT_FIT} (3 of 40 of its signals are in it)`,
      'the robot profile pairs no motor with an absolute angle (slipChecks)',
    ]
    for (const g of gaps) expect(placePart(g), g).toEqual({ unlock: { kind: 'profile' } })
  })

  it('counts slipChecks as a gap for the Logging tab too', () => {
    expect(gapIn('the robot profile pairs no motor with an absolute angle (slipChecks)')).toBe('motor with an absolute angle (slipChecks)')
  })

  it('places the companion text', () => {
    expect(placePart(NO_WATCHED_DEVICE)).toEqual({ unlock: { kind: 'companion' } })
  })

  it('places a missing key, or words for one, as a signal', () => {
    expect(placePart('missing /Test/Key')).toEqual({ unlock: { kind: 'signal', keys: ['/Test/Key'] } })
    expect(placePart('missing motor supply currents')).toEqual({ unlock: { kind: 'signal', keys: ['motor supply currents'] } })
  })

  it('places a slow signal as logging it faster, with its labels', () => {
    expect(placePart('Test Motor supply and battery voltage are logged about 20 times a second while enabled (needs 50)'))
      .toEqual({ unlock: { kind: 'signal', keys: ['Test Motor supply', 'battery voltage'], faster: true } })
  })

  it('leaves the situational reasons without an unlock', () => {
    for (const s of ['the robot was never enabled', 'not a match on the field', 'no match in this log', 'no auto on the field in this log',
      'the leader held a steady speed for only 0.4 s (needs 1 s)', 'too few current steps to measure resistance', 'no motor current to compare with',
      'only 2 accepted poses in the match (needs 5 for a rate)', 'it never moved while enabled', 'it never turned while enabled',
      'charge past 5 Ah: no healthy battery to compare with there', 'no battery voltage logged in the 2 s before auto (the log started too late)']) {
      expect(placePart(s), s).toEqual({ situational: s })
    }
  })

  it('keeps text nobody listed as another reason', () => {
    expect(placePart('something no producer says')).toEqual({ other: 'something no producer says' })
  })
})

describe('unlocks', () => {
  it('lists a rule once per kind however many parts say the same, and marks a partly checked one', () => {
    const r = unlocks([{ rule: 'power/margin', reason: 'partly checked; Left: missing /A; Right: missing /B; Right: missing /A' }])
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].unlock).toEqual({ kind: 'signal', keys: ['/A', '/B'] })
    expect(r.groups[0].rules).toEqual([{ rule: 'power/margin', partly: true, parts: ['missing /A', 'missing /B'] }])
  })

  it('puts one rule in two groups when its parts need two things', () => {
    const r = unlocks([{ rule: 'power/margin', reason: `missing /A; missing Gyro (${NO_KEY})` }])
    expect(r.groups.map((g) => unlockKey(g.unlock)).sort()).toEqual(['profile', 'signal'])
  })

  it('ranks groups by their worst rule (severity, then place in RULES), and the .hoot group last', () => {
    const errorRule = RULES.find((r) => r.severity === 'error')!.id
    const infoRule = RULES.filter((r) => r.severity === 'info').at(-1)!.id
    const r = unlocks(
      [{ rule: infoRule, reason: 'missing /A' }, { rule: errorRule, reason: `missing Gyro (${NO_KEY})` }],
      [{ rule: errorRule, reason: "only a hoot has it: load this match's .hoot" }],
    )
    expect(r.groups.map((g) => unlockKey(g.unlock))).toEqual(['profile', 'signal', 'file:.hoot'])
  })

  it('sorts situational and unknown reasons apart', () => {
    const r = unlocks([{ rule: 'x/one', reason: 'the robot was never enabled' }, { rule: 'x/two', reason: 'unlisted text' }])
    expect(r.groups).toEqual([])
    expect(r.situational).toEqual([{ rule: 'x/one', partly: false, parts: ['the robot was never enabled'] }])
    expect(r.other).toEqual([{ rule: 'x/two', partly: false, parts: ['unlisted text'] }])
  })

  it('has words and a fix for every kind', () => {
    const all: Unlock[] = [{ kind: 'file', file: '.dslog' }, { kind: 'file', file: '.hoot' }, { kind: 'signal', keys: [] }, { kind: 'signal', keys: [], faster: true }, { kind: 'profile' }, { kind: 'companion' }]
    for (const u of all) { expect(unlockWords(u)).not.toBe(''); expect(unlockFix(u)).not.toBe('') }
    expect(unlockFix({ kind: 'file', file: '.dsevents' })).toBe(DS_FILES_FIX)
  })
})

describe('what real analyses skip', () => {
  const log = (extra: FixtureEntry[] = []): FixtureEntry[] => [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [50, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: [[10, false], [12, true]] },
    { name: '/DriverStation/DSAttached', type: 'boolean', records: [[10, true]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.5], [50, 12.4]] },
    ...extra,
  ]
  const cases: [string, FixtureEntry[], typeof offseason2025 | undefined][] = [
    ['a 2025 robot log', log(), offseason2025],
    ['a 2026 robot log', log(), offseason2026],
    ['a log never enabled', [{ name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false]] }], offseason2026],
    ['a log no profile fits', log(), undefined],
  ]

  for (const [name, entries, profile] of cases) {
    it(`places every part of ${name}`, () => {
      const { report } = analyzeFiles([{ name: 'a.wpilog', bytes: writeWpilog(entries) }], profile).analyses[0]
      const r = unlocks(report.skipped)
      expect(report.skipped.length).toBeGreaterThan(0)
      expect(r.groups.length).toBeGreaterThan(0)
      expect(r.other).toEqual([])
      // Every part of every reason is in exactly one place.
      const placed = [...r.groups.flatMap((g) => g.rules), ...r.situational].flatMap((x) => x.parts)
      for (const s of report.skipped) for (const p of parts(s.reason)) expect(placed).toContain(p)
    })
  }
})

describe('sessionUnlocks', () => {
  const cell = (status: string, reason?: string) => ({ status, reason, findings: [] })
  const match = (rules: Record<string, ReturnType<typeof cell>>) => ({ rules }) as unknown as MatchSummary

  it('counts matches and cells per group, reading partly checked reasons and ignoring a missing one', () => {
    const rows = sessionUnlocks([
      match({ 'power/margin': cell('not checked', 'missing /A'), 'power/sag': cell('quiet', 'partly checked; missing /A') }),
      match({ 'power/margin': cell('not checked', 'missing /A') }),
      match({ 'power/margin': cell('not checked') }),
      match({ 'power/margin': cell('quiet') }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'signal', matches: 2 })
    expect(rows[0].rules.map((r) => [r.rule, r.notChecked, r.partly])).toEqual(expect.arrayContaining([['power/margin', 2, 0], ['power/sag', 0, 1]]))
  })

  it('is empty when nothing was skipped', () => {
    expect(sessionUnlocks([match({ 'power/margin': cell('quiet') })])).toEqual([])
  })
})
