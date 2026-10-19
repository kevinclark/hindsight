/**
 * Cut small text fixtures from the CalGames logs so the core rules can be tested without the 55 MB logs.
 * Run: npm run extract-fixtures   (reads ~/Downloads/akit_*_cacg_*.wpilog; writes fixtures/*.json)
 * Fixtures never include /RadioStatus/Status (it carries a hashed Wi-Fi key) or IP addresses.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { openWpilog, readValues } from '../src/readers/wpilog.ts'
import { readDslog } from '../src/readers/dslog.ts'
import { buildMatch, attachDslog } from '../src/match/match.ts'
import { offseason2026 as P } from '../src/profiles/2026-offseason.ts'
import type { Fixture, FixtureEntry } from '../tests/helpers/fixture-format.ts'

const DL = `${homedir()}/Downloads`
const LOGS = {
  q13: `${DL}/akit_26-10-17_20-07-34_cacg_q13.wpilog`,
  q21: `${DL}/akit_26-10-17_21-24-40_cacg_q21.wpilog`,
  p0: `${DL}/akit_26-10-18_16-31-52_cacg_p0.wpilog`,
}
const DSLOG = `${DL}/2026_10_17 13_07_13 Sat.dslog`

const r4 = (x: number) => Math.round(x * 1e4) / 1e4

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

const base = (log: ReturnType<typeof openWpilog>) => [
  cut(log, '/Timestamp', 'all', undefined, 1000),
  cut(log, P.signals.enabled, 'all'), cut(log, P.signals.autonomous, 'all'),
  cut(log, P.signals.fmsAttached, 'all'), cut(log, P.signals.dsAttached, 'all'),
  cut(log, P.signals.eventName, 'all'), cut(log, P.signals.matchType, 'all'), cut(log, P.signals.matchNumber, 'all'),
]
const isZeroLine = (v: unknown) => typeof v === 'string' && /zero/i.test(v)
const write = (name: string, f: Fixture) => { writeFileSync(`fixtures/${name}.json`, JSON.stringify(f)); console.log('wrote', name, JSON.stringify(f).length, 'bytes') }

if (!Object.values(LOGS).every(existsSync)) { console.log('CalGames logs not in ~/Downloads; nothing to extract'); process.exit(0) }

{ // Q13: auto collision, early disable, hood zero, comms loss, DS log truncated
  const log = openWpilog(new Uint8Array(readFileSync(LOGS.q13)))
  const m = buildMatch('q13', log, P)
  const ds = readDslog(new Uint8Array(readFileSync(DSLOG)))
  attachDslog(m, ds, 'q13.dslog')
  const lastRobot = ds.records.map((r) => r.voltage !== null).lastIndexOf(true)
  const firstRobot = ds.records.findIndex((r) => r.voltage !== null)
  write('q13-auto-and-comms', {
    source: 'akit_26-10-17_20-07-34_cacg_q13.wpilog + 2026_10_17 13_07_13 Sat.dslog',
    note: 'Q13: hood zero cancelled in auto, trench hit (pitch −23°), disabled with 7.4 s of auto left, comms lost twice, DS log ends at 420.5 s. DS log is synthetic: same start, length and robot-present span as the real one.',
    entries: [
      ...base(log),
      cut(log, P.signals.epochMicros, 'all', undefined, 200), cut(log, P.signals.systemTimeValid, 'all'),
      cut(log, P.signals.commsDisableCount, 'all'), cut(log, P.signals.systemActive, 'all'),
      cut(log, P.signals.batteryVoltage, [[415, 432]]),
      cut(log, P.signals.gyroPitch, [[268, 290]]), cut(log, P.signals.gyroRoll, [[268, 290]]),
      cut(log, '/Drum/Hood/PositionRotations', [[268, 296]]),
      cut(log, P.signals.console, 'all', isZeroLine),
    ],
    dslog: { name: 'q13.dslog', startEpochSeconds: ds.startEpochSeconds, count: ds.records.length, robotFrom: firstRobot, noRobotFrom: lastRobot + 1 },
  })
}
{ // Q21: flywheel followers 17/18 slow
  const log = openWpilog(new Uint8Array(readFileSync(LOGS.q21)))
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
  write('q21-follower-mismatch', {
    source: 'akit_26-10-17_21-24-40_cacg_q21.wpilog',
    note: 'Q21: flywheel followers 17 and 18 run slow at steady speed. The four flywheel velocities, only while the leader spun above 20 rot/s (±1 s).',
    entries: [...base(log), ...motors.map((x) => cut(log, x.velocity!, windows))],
  })
}
{ // P0: brownout, follower 16 off CAN, uncommitted code, hood zeroed at boot (must stay quiet)
  const log = openWpilog(new Uint8Array(readFileSync(LOGS.p0)))
  write('p0-brownout', {
    source: 'akit_26-10-18_16-31-52_cacg_p0.wpilog',
    note: 'P0: browned out from 532.8 s; flywheel follower 16 off CAN 7× at 5.85–6.31 V; uncommitted code; hood zeroed at boot so zero-not-completed must stay quiet.',
    entries: [
      ...base(log),
      cut(log, P.signals.brownedOut, 'all'), cut(log, P.signals.brownoutVoltage, 'all'),
      cut(log, P.signals.batteryVoltage, [[526, 552]]),
      cut(log, '/Drum/Flywheel/Follower 0/Connected', 'all'),
      cut(log, P.signals.gitDirty, 'all'), cut(log, P.signals.gitSha, 'all'),
      cut(log, '/Drum/Hood/PositionRotations', 'all', undefined, 1),
      cut(log, P.signals.console, 'all', isZeroLine),
    ],
  })
}
