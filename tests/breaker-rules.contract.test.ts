// Contract tests for power/main-breaker-margin and power/pdp-breaker-margin: each test proves the obligations its name
// starts with, in docs/contracts/breaker-rules.md. Synthetic logs through the real runner (analyzeFiles); made-up maps.
import { describe, expect, test } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { RULES } from '../src/rules/index.ts'
import mainRule from '../src/rules/power/main-breaker-margin.ts'
import pdpRule from '../src/rules/power/pdp-breaker-margin.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { profileId } from '../src/profiles/index.ts'
import { BREAKERS, breakerFamily, heat, steadyAmps, tripSeconds } from '../src/power/breakers.ts'
import type { PowerMap } from '../src/power/power-map.ts'
import type { HistoryEvent } from '../src/triage/history.ts'
import { writeWpilog } from './helpers/fixture-format.ts'

type Entries = Parameters<typeof writeWpilog>[0]
const modules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']
const robot = profileId(offseason2026)
const MAIN = 'power/main-breaker-margin'
const PDP = 'power/pdp-breaker-margin'
const WALL = 1762637000 // epoch seconds, 2025-11-08

const slotsOf = (...s: PowerMap['boards'][0]['slots']) => s
const map = (over: Partial<PowerMap> = {}): PowerMap => ({
  type: 'power-map', v: 1, robot, from: '2025-11-01T00:00:00.000Z', main: null, usual: null, boards: [],
  by: { device: 'laptop-a', role: 'pit' }, seq: 1, when: '2025-11-01T01:00:00.000Z', ...over,
})
const REV40 = { family: 'rev-ato', ratingA: 40 } as const

/** Enabled 10 s to 10 + seconds, every drive motor at `amps` for that long (the clock set, so a map in effect applies). */
const pushing = (amps: number, seconds = 400, only = modules, tail = 10): Entries => [
  { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [10 + seconds, false]] },
  { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
  { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [10, 11], [10 + seconds, 12.3], [20 + seconds + tail, 12.3]] },
  { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[1, (WALL + 1) * 1e6]] },
  { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[0, true]] },
  ...only.map((m) => ({ name: `/Swerve/${m} Module/DriveSupplyCurrentAmps`, type: 'double', records: [[0, 0], [10, amps], [10 + seconds, 0], [20 + seconds + tail, 0]] })),
] as Entries
const run = (entries: Entries, history: HistoryEvent[] = []) => analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], offseason2026, undefined, history).analyses[0].report
const main = (entries: Entries, history?: HistoryEvent[]) => run(entries, history).findings.find((f) => f.rule === MAIN)
const pdp = (entries: Entries, history?: HistoryEvent[]) => run(entries, history).findings.filter((f) => f.rule === PDP)

describe('[BR-01] what is already live', () => {
  test('the main rule keeps its id, title, amber level and audience; the PDP rule is registered beside it', () => {
    expect(mainRule.id).toBe(MAIN)
    expect(mainRule.title).toBe('Close to tripping the main breaker')
    expect(mainRule.severity).toBe('warning')
    expect(mainRule.judges).toBe('performance')
    expect(mainRule.averagesOverTime).toBe(true)
    expect(mainRule.who).toEqual(['software', 'drive'])
    expect(pdpRule.id).toBe(PDP)
    expect(pdpRule.severity).toBe('warning')
    expect(pdpRule.judges).toBe('performance')
    expect(pdpRule.forEach).toBe('motor')
    expect(RULES).toContain(mainRule)
    expect(RULES).toContain(pdpRule)
  })
  test('no finding is ever red, even at 300 A', () => {
    for (const amps of [40, 75, 200]) expect(main(pushing(amps, 60))?.severity).not.toBe('error')
    expect(main(pushing(75, 60))?.severity).toBe('warning')
  })
})

describe('[BR-02] the main rule fires when the fast edge reaches 100 % inside the match', () => {
  test('163 A held for minutes fires; 103 A does not', () => {
    expect(main(pushing(40))).toBeDefined() // 4 × 40 + 3 A other
    expect(main(pushing(25))).toBeUndefined()
  })
  test('the line is the fast edge, not the slow one: a load between them fires', () => {
    // Held current just under the slow edge's long-run limit (1.2265 × 120 A = 147 A) but over the fast edge's 120 A.
    const f = main(pushing(34, 400)) // 4 × 34 + 3 = 139 A
    expect(f).toBeDefined()
    expect(f!.evidence!['slow edge, peak heat (% of the trip)']).toBeLessThan(100)
    expect(f!.evidence!['fast edge, peak heat (% of the trip)']).toBeGreaterThanOrEqual(100)
  })
  test('a current that only crosses after the match ended does not fire', () => {
    // 40 A each for the 3 s the match lasts (the heat reaches nothing), then the log holds 40 A for minutes after the disable.
    const entries = pushing(40, 3)
    for (const e of entries) if (e.name.endsWith('DriveSupplyCurrentAmps')) e.records = [[0, 0], [10, 40], [13, 0], [14, 40], [600, 40]]
    expect(main(entries)).toBeUndefined()
  })
})

describe('[BR-03] the title leads with the band position', () => {
  test('the slowest would not have tripped', () => {
    const f = main(pushing(34, 400))!
    const m = /^Main breaker: a breaker at the fast end of its datasheet band would have tripped (.+) \(fast edge (\d+) %\); the slowest would not \((\d+) %\)$/.exec(f.title)
    expect(m).not.toBeNull()
    expect(Number(m![2])).toBe(f.evidence!['fast edge, peak heat (% of the trip)'])
    expect(Number(m![3])).toBe(f.evidence!['slow edge, peak heat (% of the trip)'])
  })
  test('even the slowest would have', () => {
    const f = main(pushing(75, 120))!
    expect(f.title).toMatch(/; even the slowest would have \(\d+ %\)$/)
    expect(f.evidence!['slow edge, peak heat (% of the trip)']).toBeGreaterThanOrEqual(100)
  })
  test('the time is where the fast edge first reached 100 %, inside the match', () => {
    const entries = pushing(75, 120)
    const f = main(entries)!
    const family = breakerFamily('bussmann')!
    // 4 × 75 + 3 = 303 A held from 10 s: the fast edge crosses at tripSeconds(252.5 %) after the push began.
    const t = tripSeconds((100 * 303) / 120, family.edges.fast)
    expect(f.time).toBeGreaterThan(10 + t - 0.5)
    expect(f.time).toBeLessThan(10 + t + 0.5)
  })
})

describe('[BR-04] the main rule\'s evidence', () => {
  test('keys in order, and the numbers are the model\'s', () => {
    const f = main(pushing(75, 120))!
    const e = f.evidence!
    expect(Object.keys(e)).toEqual([
      'fast edge, peak heat (% of the trip)', 'slow edge, peak heat (% of the trip)', 'judged against', 'datasheet curves', 'accuracy of the warn line',
      'steady total current that stays under the fast edge for this match\'s length (A)', 'total current, RMS over the minute before (A)', 'carried most of it',
    ])
    const family = breakerFamily('bussmann')!
    const err = family.edges.fast.fitError.currentWorst
    expect(e['accuracy of the warn line']).toContain(`about ±${Math.round(100 * ((1 + err) ** 2 - 1))} %`)
    expect(e['datasheet curves']).toBe('at 25 °C; a warm breaker or loose lugs trip sooner')
    // The match lasts 120 s of enabled time.
    expect(e['steady total current that stays under the fast edge for this match\'s length (A)']).toBeCloseTo(steadyAmps(120, 120, family.edges.fast), 0)
    expect(e['carried most of it']).toMatch(/ \(\d+ % of the current\)$/)
  })
  test('the heat figures are the datasheet model\'s peaks over the same grid', () => {
    const f = main(pushing(40, 400))!
    const family = breakerFamily('bussmann')!
    const amps = new Float64Array(Math.round(430 / 0.02)).fill(163)
    const peak = (edge: 'fast' | 'slow') => Math.round(100 * heat(amps, 0.02, 120, family.edges[edge]).reduce((m, v) => Math.max(m, v), 0))
    // The log's current is 163 A from 10 s to 410 s; the model runs on the same 50 Hz grid, so within a point or two.
    expect(Math.abs((f.evidence!['fast edge, peak heat (% of the trip)'] as number) - peak('fast'))).toBeLessThanOrEqual(2)
    expect(Math.abs((f.evidence!['slow edge, peak heat (% of the trip)'] as number) - peak('slow'))).toBeLessThanOrEqual(2)
  })
})

describe('[BR-05] the main breaker comes from the match\'s power map', () => {
  test('no map: Bussmann, assumed', () => {
    expect(main(pushing(75, 120))!.evidence!['judged against']).toBe('Bussmann CB185-120 or CB285-120 (assumed: no main breaker set in the power map)')
  })
  test('a map naming Optifuse: its parts and its heat', () => {
    const bussmann = main(pushing(75, 120))!
    const f = main(pushing(75, 120), [map({ main: 'optifuse' })])!
    expect(f.evidence!['judged against']).toBe('Optifuse 153120 or 253120 (set in the power map)')
    expect(f.evidence!['fast edge, peak heat (% of the trip)']).not.toBe(bussmann.evidence!['fast edge, peak heat (% of the trip)'])
    expect(f.evidence!['accuracy of the warn line']).toContain(`about ±${Math.round(100 * ((1 + breakerFamily('optifuse')!.edges.fast.fitError.currentWorst) ** 2 - 1))} %`)
  })
  test('a map naming Bussmann: set, not assumed; a map with no main: assumed', () => {
    expect(main(pushing(75, 120), [map({ main: 'bussmann' })])!.evidence!['judged against']).toBe('Bussmann CB185-120 or CB285-120 (set in the power map)')
    expect(main(pushing(75, 120), [map({ main: null })])!.evidence!['judged against']).toContain('assumed')
  })
})

describe('[BR-06] measured is the fast edge\'s peak against 100', () => {
  test('one entry', () => {
    const f = main(pushing(75, 120))!
    expect(f.measured).toHaveLength(1)
    expect(f.measured![0]).toMatchObject({ unit: '%', threshold: 100, value: f.evidence!['fast edge, peak heat (% of the trip)'] })
  })
})

describe('[BR-07] no match is not checked', () => {
  test('a log never enabled', () => {
    const entries: Entries = [
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [30, false]] },
      { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
      { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [30, 12.5]] },
      ...modules.map((m) => ({ name: `/Swerve/${m} Module/DriveSupplyCurrentAmps`, type: 'double', records: [[0, 0], [30, 0]] })),
    ] as Entries
    const r = run(entries)
    expect(r.findings.some((f) => f.rule === MAIN)).toBe(false)
    expect(r.skipped.find((s) => s.rule === MAIN)?.reason).toBe('no match in this log')
  })
})

/** Front Left drive alone at `amps` for `seconds` (the other motors log nothing). */
const oneMotor = (amps: number, seconds: number) => pushing(amps, seconds, ['Front Left'])
const FRONT_LEFT = 'Front Left drive' // CAN 0 in the profile
const onSlot = (breaker: PowerMap['boards'][0]['slots'][0]['breaker'], over: Partial<PowerMap> = {}) =>
  map({ usual: REV40, boards: [{ id: 'pdp', kind: 'ctre-pdp-2', slots: slotsOf({ slot: 7, breaker, feeds: { kind: 'motor', name: FRONT_LEFT, canId: 0 } }) }], ...over })

describe('[BR-08] one finding per motor past the line, about that motor', () => {
  test('one motor over the line: one finding about it', () => {
    const found = pdp(oneMotor(100, 30), [onSlot(REV40)])
    expect(found).toHaveLength(1)
    expect(found[0].key).toBe(`${PDP} · ${FRONT_LEFT}`)
  })
  test('two motors over, one under: two findings', () => {
    const entries = pushing(100, 30, ['Front Left', 'Back Right'])
    entries.push({ name: '/Swerve/Front Right Module/DriveSupplyCurrentAmps', type: 'double', records: [[0, 0], [10, 20], [40, 0], [60, 0]] } as never)
    const found = pdp(entries, [map({ usual: REV40 })])
    expect(found.map((f) => f.key).sort()).toEqual([`${PDP} · Back Right drive`, `${PDP} · ${FRONT_LEFT}`])
  })
  test('under the line: nothing; a heavy current for a moment: nothing', () => {
    expect(pdp(oneMotor(20, 300), [map({ usual: REV40 })])).toHaveLength(0)
    expect(pdp(oneMotor(100, 0.5), [map({ usual: REV40 })])).toHaveLength(0)
  })
})

describe('[BR-09] the title names the motor, breaker, slot and band position', () => {
  test('mapped slot', () => {
    const f = pdp(oneMotor(100, 30), [onSlot(REV40)])[0]
    expect(f.title).toMatch(/^Front Left drive \(CAN 0\) · PDP slot 7 · REV 40 A: a fast-end breaker would have tripped .+ \(fast \d+ %, slow \d+ %\)$/)
  })
  test('on no slot, with a usual breaker: slot not mapped', () => {
    const f = pdp(oneMotor(100, 30), [map({ usual: REV40 })])[0]
    expect(f.title).toMatch(/^Front Left drive \(CAN 0\) · slot not mapped · REV 40 A: a fast-end breaker would have tripped/)
  })
  test('no map at all: breaker not set', () => {
    const f = pdp(oneMotor(100, 30))[0]
    expect(f.title).toMatch(/^Front Left drive \(CAN 0\) · slot not mapped · breaker not set: judged against the fastest legal 40 A breaker \(Snap Action\): a fast-end breaker would have tripped/)
  })
  test('a slot on an MPM reads MPM and its id (a PDP-family breaker there is the map\'s own business)', () => {
    const m = map({ usual: REV40, boards: [{ id: 'mpm-1', kind: 'rev-mpm', slots: slotsOf({ slot: 2, breaker: null, feeds: { kind: 'motor', name: FRONT_LEFT, canId: 0 } }) }] })
    expect(pdp(oneMotor(100, 30), [m])[0].title).toMatch(/ · MPM mpm-1 slot 2 · REV 40 A: /)
  })
})

describe('[BR-10] the breaker is the one the map gives for that motor', () => {
  test('the same current trips a faster breaker kind and a smaller rating', () => {
    const heatOn = (b: PowerMap['boards'][0]['slots'][0]['breaker']) => pdp(oneMotor(70, 20), [onSlot(b)])[0]?.evidence?.['fast edge, peak heat (% of the trip)']
    const rev40 = heatOn({ family: 'rev-ato', ratingA: 40 }) as number
    const ctre40 = heatOn({ family: 'ctre-ato', ratingA: 40 }) as number
    const rev30 = heatOn({ family: 'rev-ato', ratingA: 30 }) as number
    expect(rev40).toBeGreaterThanOrEqual(100)
    expect(rev30).toBeGreaterThan(rev40)
    expect(ctre40).not.toBe(rev40)
    // A 60 A breaker (not a legal one, but the map may say so) is not tripped by 70 A in 20 s.
    expect(heatOn({ family: 'rev-ato', ratingA: 60 })).toBeUndefined()
  })
  test('found by CAN ID, whatever the map calls the motor', () => {
    const m = map({ usual: { family: 'rev-ato', ratingA: 60 }, boards: [{ id: 'pdp', kind: 'ctre-pdp-2', slots: slotsOf({ slot: 3, breaker: REV40, feeds: { kind: 'motor', name: 'drive FL', canId: 0 } }) }] })
    expect(pdp(oneMotor(100, 30), [m])[0].title).toContain('PDP slot 3')
  })
})

describe('[BR-11] the PDP evidence', () => {
  test('keys in order, and the numbers', () => {
    const f = pdp(oneMotor(100, 30), [onSlot(REV40)])[0]
    const e = f.evidence!
    expect(Object.keys(e)).toEqual(['fast edge, peak heat (% of the trip)', 'slow edge, peak heat (% of the trip)', 'peak supply current (A)', 'seconds above the breaker\'s rating', 'breaker', 'slot'])
    expect(e['peak supply current (A)']).toBe(100)
    expect(e['seconds above the breaker\'s rating']).toBeCloseTo(30, 0)
    expect(e.breaker).toBe('REV 40 A (set on its slot in the power map)')
    expect(e.slot).toBe('PDP slot 7')
    expect(f.measured).toEqual([{ label: 'Front Left drive breaker heat, fast edge', value: e['fast edge, peak heat (% of the trip)'], unit: '%', threshold: 100 }])
  })
  test('unmapped and not set', () => {
    expect(pdp(oneMotor(100, 30), [map({ usual: REV40 })])[0].evidence).toMatchObject({ breaker: 'REV 40 A (the power map\'s usual breaker)', slot: 'not mapped' })
    expect(pdp(oneMotor(100, 30))[0].evidence).toMatchObject({ breaker: 'Snap Action 40 A (not set: the fastest legal breaker is assumed)', slot: 'not mapped' })
  })
  test('the heat figures follow the breaker curve', () => {
    const f = pdp(oneMotor(100, 30), [onSlot(REV40)])[0]
    const family = breakerFamily('rev-ato')!
    const amps = new Float64Array(Math.round(40 / 0.02)).fill(0)
    amps.fill(100, 0, Math.round(30 / 0.02))
    const peak = (edge: 'fast' | 'slow') => Math.round(100 * heat(amps, 0.02, 40, family.edges[edge]).reduce((m, v) => Math.max(m, v), 0))
    expect(Math.abs((f.evidence!['fast edge, peak heat (% of the trip)'] as number) - peak('fast'))).toBeLessThanOrEqual(3)
    expect(Math.abs((f.evidence!['slow edge, peak heat (% of the trip)'] as number) - peak('slow'))).toBeLessThanOrEqual(3)
  })
})

describe('[BR-12] a breaker with no trip curve is not checked, saying so', () => {
  test('an ATM breaker on an MPM slot', () => {
    const m = map({ usual: REV40, boards: [{ id: 'mpm-1', kind: 'rev-mpm', slots: slotsOf({ slot: 2, breaker: { family: 'atm', ratingA: 10 }, feeds: { kind: 'motor', name: FRONT_LEFT, canId: 0 } }) }] })
    const r = run(oneMotor(100, 30), [m])
    expect(r.findings.some((f) => f.rule === PDP)).toBe(false)
    expect(r.skipped.find((s) => s.rule === PDP)?.reason).toContain('Front Left drive: Front Left drive is on an ATM breaker, which has no trip curve here yet')
  })
})

describe('[BR-13] only motors are judged', () => {
  test('a radio and roboRIO slot, and a heavy total, give no finding about them', () => {
    const m = map({ usual: REV40, boards: [{ id: 'pdp', kind: 'ctre-pdp-2', slots: slotsOf(
      { slot: 0, breaker: { family: 'rev-ato', ratingA: 20 }, feeds: { kind: 'radio' } },
      { slot: 1, breaker: { family: 'rev-ato', ratingA: 20 }, feeds: { kind: 'roborio' } },
      { slot: 2, breaker: { family: 'rev-ato', ratingA: 10 }, feeds: { kind: 'other', label: 'vision' } },
    ) }] })
    const found = pdp(pushing(30, 300), [m])
    expect(found).toHaveLength(0)
    const heavy = pdp(pushing(100, 30), [m])
    expect(heavy.map((f) => f.key).every((k) => k.endsWith(' drive'))).toBe(true)
  })
  test('every family of the table is one the rules know', () => {
    expect(BREAKERS.map((f) => f.id).sort()).toEqual(['bussmann', 'ctre-ato', 'optifuse', 'rev-ato', 'snap-action'])
  })
})
