/**
 * Cut small text fixtures from three of the team's 2026 match logs so the core rules can be tested without the 55 MB
 * logs. Run: npm run extract-fixtures   (reads log A, B and C from tests/helpers/team-logs.ts; writes fixtures/*.json)
 * Fixtures never include /RadioStatus/Status (it carries a hashed Wi-Fi key) or IP addresses, and name the event TEST,
 * the match 1, 2 or 3 (log A, B, C) and an invented robot commit in place of the real ones. Log A's wall clock and its
 * DS log's start move by the same made-up offset (EPOCH_SHIFT_S), so they still line up but name no real hour.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { openWpilog, readValues } from '../src/readers/wpilog.ts'
import { readDslog } from '../src/readers/dslog.ts'
import { buildMatch, attachDslog } from '../src/match/match.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { resolveSignals } from '../src/profiles/sources.ts'
import type { Fixture, FixtureEntry } from '../tests/helpers/fixture-format.ts'
import { TEAM, teamPath } from '../tests/helpers/team-logs.ts'

/** The profile with its AdvantageKit keys (these fixtures are cut from AdvantageKit logs). */
const P = { ...offseason2026, signals: resolveSignals(offseason2026.signals, () => true) }

const LOGS = { a: teamPath(TEAM.logA), b: teamPath(TEAM.logB), c: teamPath(TEAM.logC) }
const DSLOG = teamPath(TEAM.logADslog)

const r4 = (x: number) => Math.round(x * 1e4) / 1e4
/** Moves a wall-clock time off the real match day and hour: 42 days, 3 h 17 min earlier. */
const EPOCH_SHIFT_S = -(42 * 86400 + 3 * 3600 + 17 * 60)

/** Records of `name` inside any of the windows, plus the last record before each window (hold-last needs it). */
function cut(log: ReturnType<typeof openWpilog>, name: string, windows: [number, number][] | 'all', keep?: (v: unknown) => boolean, every = 1): FixtureEntry {
  const entry = log.entries.get(name)
  if (!entry) throw new Error(`missing ${name}`)
  const s = readValues(log, name)!
  const records: [number, never][] = []
  for (let i = 0; i < s.t.length; i++) {
    const t = s.t[i]
    const inside = windows === 'all' || windows.some(([a, b]) => t >= a && t <= b)
    const lastBefore = windows !== 'all' && windows.some(([a]) => t < a && (i + 1 >= s.t.length || s.t[i + 1] >= a))
    if (!(inside || lastBefore) || (keep && !keep(s.v[i])) || (every > 1 && i % every !== 0 && !lastBefore)) continue
    const v = s.v[i]
    records.push([r4(t), (typeof v === 'number' ? (entry.type === 'int64' ? v : r4(v)) : v) as never])
  }
  return { name, type: entry.type, records }
}

/** Swaps each record's value; the fixtures' event is TEST and their match number and commit made up. */
const swap = (e: FixtureEntry, f: (v: never) => unknown): FixtureEntry => ({ ...e, records: e.records.map(([t, v]) => [t, f(v as never)] as [number, never]) })
const base = (log: ReturnType<typeof openWpilog>, match: number) => [
  cut(log, '/Timestamp', 'all', undefined, 1000),
  cut(log, P.signals.enabled, 'all'), cut(log, P.signals.autonomous, 'all'),
  cut(log, P.signals.fmsAttached, 'all'), cut(log, P.signals.dsAttached, 'all'),
  swap(cut(log, P.signals.eventName, 'all'), (v: string) => (v ? 'TEST' : v)), cut(log, P.signals.matchType, 'all'),
  swap(cut(log, P.signals.matchNumber, 'all'), (v: number) => (v >= 1 && v < 1000 ? match : v)),
]
const isZeroLine = (v: unknown) => typeof v === 'string' && /zero/i.test(v)
const write = (name: string, f: Fixture) => { writeFileSync(`fixtures/${name}.json`, JSON.stringify(f)); console.log('wrote', name, JSON.stringify(f).length, 'bytes') }

if (!Object.values(LOGS).every(existsSync)) { console.log('logs A, B and C are not listed in tests/helpers/team-logs.ts; nothing to extract'); process.exit(0) }

{ // Log A: auto collision, early disable, hood zero, comms loss, DS log truncated
  const log = openWpilog(new Uint8Array(readFileSync(LOGS.a)))
  const m = buildMatch('auto-and-comms', log, P)
  const ds = readDslog(new Uint8Array(readFileSync(DSLOG)))
  attachDslog(m, ds, 'auto-and-comms.dslog')
  const lastRobot = ds.records.map((r) => r.voltage !== null).lastIndexOf(true)
  const firstRobot = ds.records.findIndex((r) => r.voltage !== null)
  write('auto-and-comms', {
    note: 'Hood zero cancelled in auto, trench hit (pitch −23°), disabled with 7.4 s of auto left, comms lost twice, DS log ends at 420.5 s. DS log is synthetic: same start, length and robot-present span as the real one.',
    entries: [
      ...base(log, 1),
      swap(cut(log, P.signals.epochMicros, 'all', undefined, 200), (v: number) => v + EPOCH_SHIFT_S * 1e6), cut(log, P.signals.systemTimeValid, 'all'),
      cut(log, P.signals.commsDisableCount, 'all'), cut(log, P.signals.systemActive, 'all'),
      cut(log, P.signals.batteryVoltage, [[415, 432]]),
      cut(log, P.signals.gyroPitch, [[268, 290]]), cut(log, P.signals.gyroRoll, [[268, 290]]),
      cut(log, '/Drum/Hood/PositionRotations', [[268, 296]]),
      cut(log, P.signals.console, 'all', isZeroLine),
    ],
    dslog: { name: 'auto-and-comms.dslog', startEpochSeconds: ds.startEpochSeconds + EPOCH_SHIFT_S, count: ds.records.length, robotFrom: firstRobot, noRobotFrom: lastRobot + 1 },
  })
}
{ // Log B: flywheel followers 17/18 slow
  const log = openWpilog(new Uint8Array(readFileSync(LOGS.b)))
  const motors = P.motorGroups.find((g) => g.name === 'Flywheel')!.motors
  // Keep only the stretches where the leader spun above 20 rot/s (shooting), with a second either side.
  const lead = readValues<number>(log, motors[0].velocity!)!
  const windows: [number, number][] = []
  for (let i = 0; i < lead.t.length; i++) {
    if (Math.abs(lead.v[i]) <= 20) continue
    const last = windows.at(-1)
    if (last && lead.t[i] - 1 <= last[1]) last[1] = lead.t[i] + 1
    else windows.push([lead.t[i] - 1, lead.t[i] + 1])
  }
  write('follower-mismatch', {
    note: 'Flywheel followers 17 and 18 run slow at steady speed. The four flywheel velocities, only while the leader spun above 20 rot/s (±1 s).',
    entries: [...base(log, 2), ...motors.map((x) => cut(log, x.velocity!, windows))],
  })
}
{ // Log A's spin-ups from standstill, and a drive stretch held at its 40 A supply limit (for the limits wizard tests)
  const log = openWpilog(new Uint8Array(readFileSync(LOGS.a)))
  const fly = P.motorGroups.find((g) => g.name === 'Flywheel')!
  const spinUps: [number, number][] = [[301.6, 305], [350.7, 354], [371.2, 374.6]]
  write('flywheel-spinups', {
    note: 'Three flywheel spin-ups from standstill (starts 302.13, 351.22, 371.73 s): velocities and supply currents of all four motors, the setpoint, the leader applied voltage and the battery voltage. The tests build bench logs from these.',
    entries: [
      ...fly.motors.flatMap((m) => [cut(log, m.velocity!, spinUps), cut(log, m.supplyCurrent!, spinUps)]),
      cut(log, fly.spinUp!.setpoint!, spinUps), cut(log, fly.spinUp!.appliedVolts!, spinUps), cut(log, P.signals.batteryVoltage, spinUps),
    ],
  })
  write('drive-plateau', {
    note: 'Front-left drive supply current, all of teleop (293–422 s): the 40 A supply limit (switched on) holding, mode 38–40 A.',
    entries: [cut(log, '/Swerve/Front Left Module/DriveSupplyCurrentAmps', [[293.1, 422.3]])],
  })
}
{ // Log C: brownout, follower 16 off CAN, uncommitted code, hood zeroed at boot (must stay quiet)
  const log = openWpilog(new Uint8Array(readFileSync(LOGS.c)))
  write('brownout', {
    note: 'Browned out from 532.8 s; flywheel follower 16 off CAN 7× at 5.85–6.31 V; uncommitted code; hood zeroed at boot so zero-not-completed must stay quiet.',
    entries: [
      ...base(log, 3),
      cut(log, P.signals.brownedOut, 'all'), cut(log, P.signals.brownoutVoltage, 'all'),
      cut(log, P.signals.batteryVoltage, [[526, 552]]),
      cut(log, '/Drum/Flywheel/Follower 0/Connected', 'all'),
      cut(log, P.signals.gitDirty, 'all'), swap(cut(log, P.signals.gitSha, 'all'), () => 'c0ffee0123456789abcdef0123456789abcdef01'),
      cut(log, '/Drum/Hood/PositionRotations', 'all', undefined, 1),
      cut(log, P.signals.console, 'all', isZeroLine),
    ],
  })
}
