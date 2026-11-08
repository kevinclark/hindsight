// Contract tests for src/power/power-map.ts and its history line: each test proves the obligations its name starts
// with, in docs/contracts/power-map.md. Made-up robots and maps only.
import { describe, expect, test } from 'vitest'
import { analyzeFiles, withPowerMaps } from '../src/analyze.ts'
import { boardStamp, compareEvents, parseHistory, serializeHistory, type HistoryEvent } from '../src/triage/history.ts'
import { breakerForMotor, mainBreakerFor, powerMapAt, type PowerMap } from '../src/power/power-map.ts'
import { profileId } from '../src/profiles/index.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { writeWpilog } from './helpers/fixture-format.ts'

type Entries = Parameters<typeof writeWpilog>[0]
const map = (over: Partial<PowerMap> = {}): PowerMap => ({
  type: 'power-map', v: 1, robot: 'Test robot @ main', from: '2026-11-01T09:00:00.000Z', main: 'bussmann', usual: { family: 'rev-ato', ratingA: 40 },
  boards: [
    { id: 'pdp', kind: 'ctre-pdp-2', slots: [
      { slot: 7, breaker: { family: 'snap-action', ratingA: 30 }, feeds: { kind: 'motor', name: 'Intake left', canId: 14 } },
      { slot: 8, breaker: { family: 'rev-ato', ratingA: 40 }, feeds: { kind: 'motor', name: 'Shooter' } },
      { slot: 9, breaker: null, feeds: { kind: 'motor', name: 'Hood', canId: 20 } },
      { slot: 0, breaker: { family: 'rev-ato', ratingA: 20 }, feeds: { kind: 'radio' } },
    ] },
    { id: 'mpm-1', kind: 'rev-mpm', fedFrom: { board: 'pdp', slot: 3 }, slots: [{ slot: 2, breaker: { family: 'atm', ratingA: 10 }, feeds: { kind: 'motor', name: 'Climber', canId: 30 } }] },
  ],
  by: { device: 'laptop-a', role: 'pit' }, seq: 1, when: '2026-11-01T10:00:00.000Z', ...over,
})
const line = (m: unknown) => JSON.stringify(m)

describe('[PM-01] a well-formed line round-trips', () => {
  test('parses to a power-map event and writes back the same text', () => {
    const text = line(map())
    const { events, skipped } = parseHistory(text)
    expect(skipped).toBe(0)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('power-map')
    expect(serializeHistory(events)).toBe(text + '\n')
  })
  test('the other line types parse as before, beside it', () => {
    const issue = line({ type: 'issue', key: 'a · b', status: 'known', note: '', when: '2026-11-01T00:00:00.000Z' })
    const { events } = parseHistory([issue, line(map())].join('\n'))
    expect(events.map((e) => e.type)).toEqual(['issue', 'power-map'])
  })
})

test('[PM-10] a slot listed twice (two feeds on one slot: the screen flags it, R621) is kept as a map line', () => {
  const twice = map({ boards: [{ id: 'pdp', kind: 'ctre-pdp-2', slots: [
    { slot: 1, breaker: null, feeds: { kind: 'motor', name: 'A' } }, { slot: 1, breaker: null, feeds: { kind: 'motor', name: 'B' } },
  ] }] })
  const { events } = parseHistory(line(twice))
  expect(events[0].type).toBe('power-map')
  expect(serializeHistory(events)).toBe(line(twice) + '\n')
})

describe('[PM-02] a line that fails a check is kept, written back unchanged, never half-read', () => {
  const m = map()
  const slot0 = (s: object) => ({ ...m, boards: [{ id: 'pdp', kind: 'ctre-pdp-2', slots: [s] }] })
  const bad: [string, unknown][] = [
    ['v 2', { ...m, v: 2 }],
    ['no robot', { ...m, robot: '' }],
    ['from not a time', { ...m, from: 'yesterday' }],
    ['unknown main', { ...m, main: 'acme' }],
    ['main missing', (({ main: _m, ...rest }) => rest)(m)],
    ['usual of an unknown family', { ...m, usual: { family: 'acme', ratingA: 40 } }],
    ['usual rating 0', { ...m, usual: { family: 'rev-ato', ratingA: 0 } }],
    ['unknown board kind', { ...m, boards: [{ id: 'x', kind: 'pdh', slots: [] }] }],
    ['board kind that is an object property name', { ...m, boards: [{ id: 'x', kind: 'toString', slots: [] }] }],
    ['board kind constructor', { ...m, boards: [{ id: 'x', kind: 'constructor', slots: [] }] }],
    ['boards not a list', { ...m, boards: 'none' }],
    ['PDP slot 24', slot0({ slot: 24, breaker: null, feeds: null })],
    ['PDP slot -1', slot0({ slot: -1, breaker: null, feeds: null })],
    ['MPM slot 6', { ...m, boards: [{ id: 'm', kind: 'rev-mpm', slots: [{ slot: 6, breaker: null, feeds: null }] }] }],
    ['ATM breaker on the PDP', slot0({ slot: 1, breaker: { family: 'atm', ratingA: 10 }, feeds: null })],
    ['REV ATO breaker on an MPM', { ...m, boards: [{ id: 'm', kind: 'rev-mpm', slots: [{ slot: 1, breaker: { family: 'rev-ato', ratingA: 10 }, feeds: null }] }] }],
    ['breaker rating text', slot0({ slot: 1, breaker: { family: 'rev-ato', ratingA: '40' }, feeds: null })],
    ['feed of an unknown kind', slot0({ slot: 1, breaker: null, feeds: { kind: 'toaster' } })],
    ['motor feed with no name', slot0({ slot: 1, breaker: null, feeds: { kind: 'motor', name: '' } })],
    ['no by', (({ by: _b, ...rest }) => rest)(m)],
    ['role not a role', { ...m, by: { device: 'a', role: 'boss' } }],
    ['no seq', (({ seq: _s, ...rest }) => rest)(m)],
  ]
  for (const [name, e] of bad) {
    test(name, () => {
      const text = line(e)
      const { events, skipped } = parseHistory(text)
      expect(skipped).toBe(0)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('opaque')
      expect(serializeHistory(events)).toBe(text + '\n')
    })
  }
})

describe('[PM-03] a power-map line is stamped and ordered like a board line', () => {
  test('boardStamp counts it: next seq is one more than the device\'s largest', () => {
    const history: HistoryEvent[] = [map({ seq: 4 }), map({ seq: 9, by: { device: 'laptop-b', role: 'pit' } })]
    expect(boardStamp(history, 'laptop-a', new Date('2026-11-02T00:00:00Z')).seq).toBe(5)
    expect(boardStamp(history, 'laptop-b', new Date('2026-11-02T00:00:00Z')).seq).toBe(10)
    expect(boardStamp(history, 'laptop-c', new Date('2026-11-02T00:00:00Z')).seq).toBe(1)
  })
  test('boardStamp\'s when is never before the newest line it has seen', () => {
    const history: HistoryEvent[] = [map({ when: '2030-01-01T00:00:00.000Z' })]
    expect(boardStamp(history, 'laptop-a', new Date('2026-11-02T00:00:00Z')).when).toBe('2030-01-01T00:00:00.000Z')
  })
  test('compareEvents orders by when, then device, then seq', () => {
    const a = map({ seq: 2 })
    const b = map({ seq: 1 })
    const c = map({ seq: 1, by: { device: 'laptop-0', role: 'pit' } })
    expect([a, b, c].sort(compareEvents)).toEqual([c, b, a])
  })
})

describe('[PM-04] the map in effect at a time', () => {
  const a = map({ from: '2026-11-01T09:00:00.000Z', main: 'bussmann', seq: 1 })
  const b = map({ from: '2026-11-05T09:00:00.000Z', main: 'optifuse', seq: 2 })
  const other = map({ robot: 'Other @ main', from: '2026-11-06T00:00:00.000Z' })
  const history: HistoryEvent[] = [b, other, a, { type: 'opaque', raw: '{}', when: '' }]
  test('the latest from at or before the time', () => {
    expect(powerMapAt(history, 'Test robot @ main', '2026-11-05T09:00:00.000Z')).toBe(b)
    expect(powerMapAt(history, 'Test robot @ main', '2026-11-05T08:59:59.999Z')).toBe(a)
    expect(powerMapAt(history, 'Test robot @ main', '2027-01-01T00:00:00.000Z')).toBe(b)
  })
  test('null before the first line, and for a robot with none', () => {
    expect(powerMapAt(history, 'Test robot @ main', '2026-10-31T23:59:59.000Z')).toBeNull()
    expect(powerMapAt(history, 'Nobody @ main', '2027-01-01T00:00:00.000Z')).toBeNull()
    expect(powerMapAt([], 'Test robot @ main', '2027-01-01T00:00:00.000Z')).toBeNull()
  })
  test('equal from: later when first (seq counts per device), then higher seq', () => {
    const x = map({ seq: 9, when: '2026-11-01T00:00:00.000Z', main: 'optifuse' }) // a busy laptop's high seq, written earlier
    const y = map({ seq: 2, when: '2026-11-02T00:00:00.000Z', main: 'bussmann', by: { device: 'laptop-b', role: 'pit' } })
    expect(powerMapAt([x, y], 'Test robot @ main', '2026-12-01T00:00:00.000Z')).toBe(y)
    expect(powerMapAt([y, x], 'Test robot @ main', '2026-12-01T00:00:00.000Z')).toBe(y)
    const p = map({ seq: 3, when: '2026-11-02T00:00:00.000Z' })
    const q = map({ seq: 4, when: '2026-11-02T00:00:00.000Z' })
    expect(powerMapAt([q, p], 'Test robot @ main', '2026-12-01T00:00:00.000Z')).toBe(q)
    expect(powerMapAt([p, q], 'Test robot @ main', '2026-12-01T00:00:00.000Z')).toBe(q)
  })
})

describe('[PM-05] a motor is found on its slot by CAN ID, else by name', () => {
  const m = map()
  test('same CAN ID: found, with board and slot and its breaker', () => {
    expect(breakerForMotor(m, 'Whatever it is called now', 14)).toEqual({ family: 'snap-action', ratingA: 30, board: 'pdp', slot: 7, mapped: true, source: 'slot' })
  })
  test('both have an ID and they differ: another motor, even with the same name', () => {
    const b = breakerForMotor(m, 'Intake left', 15)
    expect(b.mapped).toBe(false)
  })
  test('the feed has no ID: found by name', () => {
    expect(breakerForMotor(m, 'Shooter', 12)).toMatchObject({ family: 'rev-ato', ratingA: 40, board: 'pdp', slot: 8, mapped: true, source: 'slot' })
    expect(breakerForMotor(m, 'Shooter')).toMatchObject({ slot: 8, mapped: true })
  })
  test('the motor has no ID but the feed has: found by name', () => {
    expect(breakerForMotor(m, 'Intake left')).toMatchObject({ slot: 7, mapped: true })
  })
  test('a motor on an MPM slot: its ATM breaker and that board', () => {
    expect(breakerForMotor(m, 'Climber', 30)).toEqual({ family: 'atm', ratingA: 10, board: 'mpm-1', slot: 2, mapped: true, source: 'slot' })
  })
  test('a radio feed is never a motor', () => {
    expect(breakerForMotor(m, 'radio')).toMatchObject({ mapped: false })
  })
  test('boards are searched in order: the first slot wins', () => {
    const twice = map({ boards: [m.boards[1], { id: 'pdp', kind: 'ctre-pdp-2', slots: [{ slot: 5, breaker: { family: 'rev-ato', ratingA: 40 }, feeds: { kind: 'motor', name: 'Climber', canId: 30 } }] }] })
    expect(breakerForMotor(twice, 'Climber', 30)).toMatchObject({ board: 'mpm-1' })
  })
})

describe('[PM-06] a motor on no slot gets the usual breaker; a slot with no breaker is still mapped', () => {
  const m = map()
  test('on no slot: usual', () => {
    expect(breakerForMotor(m, 'Elsewhere', 40)).toEqual({ family: 'rev-ato', ratingA: 40, mapped: false, source: 'usual' })
  })
  test('on a slot with no breaker set: mapped, with the usual breaker', () => {
    expect(breakerForMotor(m, 'Hood', 20)).toEqual({ family: 'rev-ato', ratingA: 40, board: 'pdp', slot: 9, mapped: true, source: 'usual' })
  })
  test('on a slot with no breaker and no usual: mapped, the assumed breaker', () => {
    expect(breakerForMotor(map({ usual: null }), 'Hood', 20)).toEqual({ family: 'snap-action', ratingA: 40, board: 'pdp', slot: 9, mapped: true, source: 'not set' })
  })
})

describe('[PM-07] nothing set: the fastest legal 40 A breaker', () => {
  test('no map', () => {
    expect(breakerForMotor(null, 'Any', 1)).toEqual({ family: 'snap-action', ratingA: 40, mapped: false, source: 'not set' })
  })
  test('a map with no usual and no slot for the motor', () => {
    expect(breakerForMotor(map({ usual: null }), 'Elsewhere')).toEqual({ family: 'snap-action', ratingA: 40, mapped: false, source: 'not set' })
  })
})

describe('[PM-08] the main breaker', () => {
  test('the map\'s, else Bussmann assumed', () => {
    expect(mainBreakerFor(map({ main: 'optifuse' }))).toEqual({ family: 'optifuse', source: 'map' })
    expect(mainBreakerFor(map({ main: 'bussmann' }))).toEqual({ family: 'bussmann', source: 'map' })
    expect(mainBreakerFor(map({ main: null }))).toEqual({ family: 'bussmann', source: 'assumed' })
    expect(mainBreakerFor(null)).toEqual({ family: 'bussmann', source: 'assumed' })
  })
})

describe('[PM-09] analyzeFiles gives each match the map in effect when it was played', () => {
  const robot = profileId(offseason2026)
  const WALL = 1762637000 // 2025-11-08, epoch seconds
  const log = (wall: number | null): Entries => [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [20, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
    ...(wall === null ? [] : [
      { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[1, (wall + 1) * 1e6]] },
      { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[0, true]] },
    ]),
  ] as Entries
  const early = map({ robot, from: '2025-11-01T00:00:00.000Z', main: 'bussmann', seq: 1 })
  const late = map({ robot, from: '2025-11-09T00:00:00.000Z', main: 'optifuse', seq: 2 })
  const run = (wall: number | null, history: HistoryEvent[], files: { name: string; bytes: Uint8Array }[] = []) =>
    analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(log(wall)) }, ...files], offseason2026, undefined, history)
  test('a match played between two maps gets the earlier one; one played after both, the later', () => {
    expect(run(WALL, [early, late]).analyses[0].match.powerMap).toBe(early)
    expect(run(WALL + 3 * 86400, [early, late]).analyses[0].match.powerMap).toBe(late)
  })
  test('a match played before any map gets none', () => {
    expect(run(WALL - 30 * 86400, [early, late]).analyses[0].match.powerMap).toBeNull()
  })
  test('a match whose clock was never set gets the robot\'s latest map', () => {
    expect(run(null, [early, late]).analyses[0].match.powerMap).toBe(late)
  })
  test('no history, or only another robot\'s: none', () => {
    expect(run(WALL, []).analyses[0].match.powerMap).toBeNull()
    expect(run(WALL, [map({ robot: 'Other @ main' })]).analyses[0].match.powerMap).toBeNull()
  })
  test('lines from a dropped-in history file count, and the result\'s history is only the file\'s', () => {
    const file = { name: 'hindsight-history.jsonl', bytes: new TextEncoder().encode(serializeHistory([early])) }
    const r = run(WALL, [], [file])
    expect(r.analyses[0].match.powerMap?.from).toBe(early.from)
    expect(r.history).toHaveLength(1)
    const r2 = run(WALL, [late], [file])
    expect(r2.history).toHaveLength(1)
  })
})

describe('[PM-11] a changed map re-runs only the two breaker rules on the open analyses', () => {
  const robot = profileId(offseason2026)
  const WALL = 1762637000
  const entries: Entries = [
    { name: '/DriverStation/Enabled', type: 'boolean', records: [[0, false], [10, true], [130, false]] },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: [[0, false]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[0, 12.5], [10, 11], [130, 12.3], [150, 12.3]] },
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[1, (WALL + 1) * 1e6]] },
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[0, true]] },
    ...['Front Left', 'Front Right', 'Back Left', 'Back Right'].map((m) => ({ name: `/Swerve/${m} Module/DriveSupplyCurrentAmps`, type: 'double', records: [[0, 0], [10, 75], [130, 0], [150, 0]] })),
  ] as Entries
  const open = () => analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], offseason2026)
  const words = (a: { report: { findings: { rule: string; key: string; severity: string; title: string; evidence: object }[]; skipped: object[] } }) =>
    JSON.stringify([a.report.findings.map((f) => [f.rule, f.key, f.severity, f.title, f.evidence]), a.report.skipped])
  const optifuse = map({ robot, from: '2025-11-01T00:00:00.000Z', main: 'optifuse' })

  test('the new report is what a fresh read with that history gives, and other findings are the same objects', () => {
    const first = open().analyses
    const before = first[0].report.findings.filter((f) => !f.rule.startsWith('power/') || !f.rule.endsWith('-breaker-margin')).filter((f) => f.rule !== 'meta/not-checked')
    const next = withPowerMaps(first, [optifuse])!
    expect(next).not.toBeNull()
    expect(next[0].match.powerMap).toBe(optifuse)
    expect(next[0].report.findings.find((f) => f.rule === 'power/main-breaker-margin')!.evidence['judged against']).toContain('Optifuse')
    const after = next[0].report.findings.filter((f) => !f.rule.startsWith('power/') || !f.rule.endsWith('-breaker-margin')).filter((f) => f.rule !== 'meta/not-checked')
    expect(after).toHaveLength(before.length)
    expect(after.every((f) => before.includes(f))).toBe(true)
    const fresh = analyzeFiles([{ name: 't.wpilog', bytes: writeWpilog(entries) }], offseason2026, undefined, [optifuse]).analyses[0]
    expect(words(next[0])).toBe(words(fresh))
  })
  test('nothing changed: null, so a caller keeps what it has; a second map line in effect changes it again', () => {
    const first = open().analyses
    const next = withPowerMaps(first, [optifuse])!
    expect(withPowerMaps(next, [optifuse])).toBeNull()
    expect(withPowerMaps(next, [optifuse, map({ robot, from: '2025-11-02T00:00:00.000Z', main: 'bussmann', seq: 2 })])).not.toBeNull()
    expect(withPowerMaps(open().analyses, [])).toBeNull()
  })
})
