// The rules added after the 2025 robot's offseason event: a made-up log that
// must fire each one and one that must stay quiet, then the real logs (skipped when they aren't on this Mac; they are
// never copied into the repo).
import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { analyzeFiles } from '../src/analyze.ts'
import { offseason2025 } from '../src/profiles/2025-offseason.ts'
import type { Finding } from '../src/rules/types.ts'
import { writeWpilog, type FixtureEntry } from './helpers/fixture-format.ts'
import { fired, readInput } from './helpers/load.ts'
import { TEAM, TEAM_LOGS_FILE, teamPath } from './helpers/team-logs.ts'

type Entries = FixtureEntry[]
const WALL = 1762637000 // 2025-11-08, epoch seconds

/** A 2025-robot log: the DS state, the robot clock (wall = base + robot time) and anything else given. */
function robotLog(o: { base: number; until: number; enabled: [number, boolean][]; auto?: [number, boolean][]; fms?: [number, boolean][]; extra?: Entries }): Entries {
  const start = o.enabled[0][0]
  return [
    { name: '/DriverStation/Enabled', type: 'boolean', records: o.enabled },
    { name: '/DriverStation/Autonomous', type: 'boolean', records: o.auto ?? [[start, false]] },
    { name: '/DriverStation/FMSAttached', type: 'boolean', records: o.fms ?? [[start, true]] },
    { name: '/DriverStation/DSAttached', type: 'boolean', records: [[start, true]] },
    { name: '/DriverStation/EventName', type: 'string', records: [[start, 'TEST']] },
    { name: '/DriverStation/MatchType', type: 'int64', records: [[start, 2]] },
    { name: '/DriverStation/MatchNumber', type: 'int64', records: [[start, 4]] },
    { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[start, true]] },
    { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[start, (o.base + start) * 1e6], [o.until, (o.base + o.until) * 1e6]] },
    { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[start, 12.5], [o.until, 12.4]] },
    ...(o.extra ?? []),
  ]
}

const analyze = (logs: Record<string, Entries>) =>
  analyzeFiles(Object.entries(logs).map(([name, entries]) => ({ name, bytes: writeWpilog(entries) })), offseason2025).analyses
const findingsOf = (logs: Record<string, Entries>, file: string, rule: string): Finding[] =>
  analyze(logs).find((a) => a.match.fileName === file)!.report.findings.filter((f) => f.rule === rule)
const joysticks = (t: number, counts: number[]): Entries =>
  counts.map((n, port) => ({ name: `/DriverStation/Joystick${port}/ButtonCount`, type: 'int64', records: [[t, n]] }))

describe('loop/restart-mid-match', () => {
  // Piece 1: a normal start, auto, then teleop until the log stops while enabled. Piece 2: back 15 s later, enabled.
  const piece1 = robotLog({ base: WALL, until: 60, enabled: [[10, false], [20, true], [35, false], [38, true]], auto: [[10, false], [20, true], [35, false]], fms: [[10, false], [12, true]], extra: joysticks(10, [16, 16]) })
  const piece2 = robotLog({ base: WALL + 64, until: 30, enabled: [[11, true], [25, false]], extra: joysticks(11, [0, 16]) })
  const logs = { 'piece1.wpilog': piece1, 'piece2.wpilog': piece2 }

  it('fires on a log that ends enabled on the field, with the gap to the next piece', () => {
    const [f] = findingsOf(logs, 'piece1.wpilog', 'loop/restart-mid-match')
    expect(f.title).toMatch(/Robot program stopped at 0:39 into the match \(teleop.*the next log starts 15 s later/)
    expect(f.evidence['between logs, program down or starting up (s, ±2)']).toBe('15.0')
    expect(f.causes.find((c) => c.id === 'cut-short')?.ruledOut).toBeTruthy()
    expect(f.causes.find((c) => c.id === 'slow-sag')?.ruledOut).toMatch(/12\.40 V/)
  })
  it('fires on a log that starts enabled on the field, and names the controller that did not come back', () => {
    const [f] = findingsOf(logs, 'piece2.wpilog', 'loop/restart-mid-match')
    expect(f.title).toMatch(/restarted mid-match: this log starts already enabled on the field, 15 s after the previous log stopped; no controller on port 0/)
    expect(f.time).toBeNull()
  })
  it('alone, a restarted piece still fires and says the other logs are not loaded', () => {
    const [f] = findingsOf({ 'piece2.wpilog': piece2 }, 'piece2.wpilog', 'loop/restart-mid-match')
    expect(f.evidence['logs of this match loaded']).toBe('only this one')
    expect(f.evidence['controllers in the first 10 s of this log']).toBe('port 1')
  })
  it('a later log of the same match label that starts normally (a replay) is not the other side of a restart', () => {
    const replay = robotLog({ base: WALL + 1200, until: 200, enabled: [[10, false], [20, true], [35, false], [38, true], [173, false]], auto: [[10, false], [20, true], [35, false]], fms: [[10, false], [12, true], [180, false]] })
    const [f] = findingsOf({ 'piece1.wpilog': piece1, 'replay.wpilog': replay }, 'piece1.wpilog', 'loop/restart-mid-match')
    expect(f.title).not.toMatch(/next log/)
    expect(f.evidence['between logs, program down or starting up (s, ±2)']).toBeUndefined()
  })
  it('stays quiet on a normal field log and off the field', () => {
    const normal = robotLog({ base: WALL, until: 200, enabled: [[10, false], [20, true], [35, false], [38, true], [173, false]], auto: [[10, false], [20, true], [35, false]], fms: [[10, false], [12, true], [180, false]] })
    expect(findingsOf({ 'n.wpilog': normal }, 'n.wpilog', 'loop/restart-mid-match')).toEqual([])
    const pit = robotLog({ base: WALL, until: 60, enabled: [[10, false], [20, true]], fms: [[10, false]] })
    expect(findingsOf({ 'p.wpilog': pit }, 'p.wpilog', 'loop/restart-mid-match')).toEqual([])
  })
})

describe('comms/emergency-stop', () => {
  const estop = (records: [number, boolean][]): Entries => [{ name: '/DriverStation/EmergencyStop', type: 'boolean', records }]
  it('on the field: an error with the time left in the period', () => {
    const log = robotLog({ base: WALL, until: 200, enabled: [[10, false], [20, true], [35, false], [38, true], [100, false]], auto: [[10, false], [20, true], [35, false]], extra: estop([[10, false], [100, true]]) })
    const [f] = findingsOf({ 'q.wpilog': log }, 'q.wpilog', 'comms/emergency-stop')
    expect(f.severity).toBe('error')
    expect(f.title).toMatch(/E-stopped at 1:19 into the match \(teleop.* with 73\.0 s of teleop left/)
  })
  it('off the field right after an enable: a warning that points at a key pressed at enable', () => {
    const log = robotLog({ base: WALL, until: 60, enabled: [[10, false], [20, true], [20.02, false]], fms: [[10, false]], extra: estop([[10, false], [20.02, true]]) })
    const [f] = findingsOf({ 'p.wpilog': log }, 'p.wpilog', 'comms/emergency-stop')
    expect(f.severity).toBe('warning')
    expect(f.title).toMatch(/0\.02 s after the robot was enabled/)
    expect(f.nextStep).toMatch(/space bar/)
  })
  it('stays quiet when the flag never turns on', () => {
    const log = robotLog({ base: WALL, until: 60, enabled: [[10, false], [20, true]], extra: estop([[10, false]]) })
    expect(findingsOf({ 'q.wpilog': log }, 'q.wpilog', 'comms/emergency-stop')).toEqual([])
  })
})

describe('can/bus-dropout and can/device-dropout on a whole bus', () => {
  const modules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']
  const bus = (gyro: [number, boolean][], status: [number, string][]): Entries => [
    { name: '/Swerve/Gyro/IsConnected', type: 'boolean', records: gyro },
    ...modules.map((m): FixtureEntry => ({ name: `/RealOutputs/Module${m}refresh status code`, type: 'string', records: status })),
  ]
  const log = (extra: Entries) => ({ 'b.wpilog': robotLog({ base: WALL, until: 100, enabled: [[10, false], [20, true]], extra }) })
  // The bus finding first, then the per-device ones.
  const run = (extra: Entries) => ['can/bus-dropout', 'can/device-dropout'].flatMap((rule) => findingsOf(log(extra), 'b.wpilog', rule))

  it('every device on the bus at once is one finding about the bus', () => {
    const found = run(bus([[10, true], [40, false], [50, true]], [[10, 'OK'], [40.4, 'CanMessageStale'], [50.2, 'OK']]))
    expect(found).toHaveLength(1)
    expect(found[0].about).toBe('CANivore bus')
    expect(found[0].title).toMatch(/Every device on the CANivore bus that reports its health \(5\) stopped reporting at once at .* for 10 s/)
    expect(found[0].evidence['status the devices reported']).toBe('CanMessageStale')
    expect(found[0].causes[0]).toMatchObject({ id: 'bus', likely: true })
  })
  it('members that were already down don\'t make a blip a whole-bus drop', () => {
    const found = run(bus([[10, true], [40, false], [41, true]], [[10, 'OK'], [12, 'CanMessageStale']]))
    expect(found.map((f) => f.about)).toEqual(['Gyro (Pigeon)'])
  })
  it('the gyro alone is still the gyro', () => {
    const found = run(bus([[10, true], [40, false], [41, true]], [[10, 'OK']]))
    expect(found).toHaveLength(1)
    expect(found[0].title).toMatch(/^Gyro \(Pigeon\) dropped off CAN 1 time/)
  })
})

describe('auto/early-disable: the auto\'s earlier runs', () => {
  const autoLog = (base: number, sha: string, dirty: string, autoEnd: number): Entries => robotLog({
    base, until: 200, enabled: [[10, false], [20, true], [autoEnd, false], [38, true], [173, false]], auto: [[10, false], [20, true], [35, false]],
    extra: [
      { name: '/NetworkInputs/SmartDashboard/Autos', type: 'string', records: [[10, 'Left stack auto']] },
      { name: '/RealMetadata/GitSHA', type: 'string', records: [[10, sha]] },
      { name: '/RealMetadata/GitDirty', type: 'string', records: [[10, dirty]] },
    ],
  })
  const practice = autoLog(WALL - 3600, 'b0a7123aaaa', 'Uncommitted changes', 35)
  const match = autoLog(WALL, '0a5a119bbbb', 'All changes committed', 21)

  it('names the auto and its last run on another build, and marks "not run before on this build" likely', () => {
    const [f] = findingsOf({ 'practice.wpilog': practice, 'match.wpilog': match }, 'match.wpilog', 'auto/early-disable')
    expect(f.evidence.auto).toBe('Left stack auto')
    expect(f.evidence['runs of it in the other logs loaded, earlier']).toBe(1)
    expect(f.evidence['runs of it on this build (0a5a119), in the logs loaded']).toBe(0)
    expect(f.evidence['its last earlier run']).toBe('practice.wpilog, on the field, build b0a7123 with uncommitted changes: ran the whole auto')
    expect(f.causes[0]).toMatchObject({ id: 'new-auto', likely: true })
  })
  it('loaded logs that are all later prove nothing about a first run', () => {
    const later = autoLog(WALL + 3600, 'b0a7123aaaa', 'All changes committed', 35)
    const [f] = findingsOf({ 'later.wpilog': later, 'match.wpilog': match }, 'match.wpilog', 'auto/early-disable')
    expect(f.evidence['runs of it in the other logs loaded, earlier']).toBe(0)
    expect(f.causes.find((c) => c.id === 'new-auto')?.likely).toBeUndefined()
  })
  it('alone, it says what it cannot know instead of claiming a first run', () => {
    const [f] = findingsOf({ 'match.wpilog': match }, 'match.wpilog', 'auto/early-disable')
    expect(f.evidence['runs of it in the other logs loaded, earlier']).toBe('not known (only this log is loaded)')
    expect(f.causes.find((c) => c.id === 'new-auto')?.likely).toBeUndefined()
  })
})

describe('vision/outliers with odometry off the field', () => {
  const run = (odometry: { x: number; y: number }) => {
    const times = Array.from({ length: 30 }, (_, i) => 21 + i)
    const log = robotLog({
      base: WALL, until: 100, enabled: [[10, false], [20, true], [35, false], [38, true], [90, false]], auto: [[10, false], [20, true], [35, false]],
      extra: [
        { name: '/RealOutputs/Alerts/errors', type: 'string[]', records: [[10, []]] },
        { name: '/RealOutputs/Odometry/Robot', type: 'struct:Pose2d', records: [[10, { ...odometry, rot: 0 }]] },
        { name: '/RealOutputs/Vision/Left_Drivebase/Pose2d', type: 'struct:Pose2d', records: times.map((t): [number, { x: number; y: number; rot: number }] => [t, { x: 6, y: 4, rot: 0 }]) },
      ],
    })
    return findingsOf({ 'v.wpilog': log }, 'v.wpilog', 'vision/outliers')[0]
  }
  it('says the distances measure odometry when it was off the field', () => {
    const f = run({ x: -4.7, y: -3.9 })
    expect(f.title).toMatch(/odometry was off the field for 30 of them$/)
    expect(f.causes[0]).toMatchObject({ id: 'odometry', likely: true })
    expect(f.evidence['odometry when auto started (m)']).toBe('(-4.7, -3.9) m')
  })
  it('is unchanged when odometry was on the field', () => {
    const f = run({ x: 2, y: 2 })
    expect(f.title).not.toMatch(/off the field/)
    expect(f.evidence['odometry when auto started (m)']).toBeUndefined()
  })
})

describe('mech/stuck-state', () => {
  const STATE = '/RealOutputs/Superstructure/State', ARM = '/RealOutputs/Arm/Has Game Piece', AT = '/RealOutputs/Superstructure/At Extension?'
  const PRESS = '/RealOutputs/Superstructure/Score Request'
  // Five normal handoffs (arm has-piece rises 0.1 s before each exit), then one that never ends.
  const handoffs = (stuckFrom: number, presses: number[]): Entries => {
    const state: [number, string][] = [[10, 'IDLE']], arm: [number, boolean][] = [[10, false]], at: [number, boolean][] = [[10, true]]
    for (let i = 0; i < 5; i++) {
      const t = 20 + 10 * i
      state.push([t, 'RIGHT_HANDOFF'], [t + 2, 'IDLE'])
      arm.push([t + 1.9, true], [t + 5, false])
      at.push([t + 2, false], [t + 3, true]) // flips in the same loop as the exit: a result of leaving, never the trigger
    }
    state.push([stuckFrom, 'RIGHT_HANDOFF'])
    return [
      { name: STATE, type: 'string', records: state },
      { name: ARM, type: 'boolean', records: arm },
      { name: AT, type: 'boolean', records: at },
      { name: PRESS, type: 'boolean', records: [[10, false], ...presses.flatMap((t): [number, boolean][] => [[t, true], [t + 0.2, false]])] },
    ]
  }
  const run = (extra: Entries) => findingsOf({ 's.wpilog': robotLog({ base: WALL, until: 150, enabled: [[10, false], [15, true]], extra }) }, 's.wpilog', 'mech/stuck-state')

  it('fires on 20 s or more in one state with driver presses, and names what the state waits for', () => {
    const [f] = run(handoffs(100, [110, 120]))
    expect(f.title).toMatch(/^Superstructure stayed in RIGHT_HANDOFF for 50 s while enabled, .* through 2 driver requests; it usually leaves when Arm has game piece turns true, which never happened$/)
    expect(f.evidence['what it usually waits for (learned from its exits)']).toMatch(/^Arm has game piece turns true: in the 0.3 s before 5 of 5 exits/)
    expect(f.about).toBe('RIGHT_HANDOFF')
  })
  it('stays quiet without a press, under 20 s, or in a state that waits on purpose', () => {
    expect(run(handoffs(100, []))).toEqual([])
    expect(run(handoffs(135, [140]))).toEqual([])
    const climb: Entries = [{ name: STATE, type: 'string', records: [[10, 'IDLE'], [20, 'PRE_CLIMB']] }, { name: PRESS, type: 'boolean', records: [[10, false], [30, true]] }]
    expect(run(climb)).toEqual([])
  })
  it('names nothing below the floor of 5 exits', () => {
    const few = handoffs(100, [110]).map((e) => (e.name === STATE ? { ...e, records: e.records.filter((r) => r[0] < 40 || r[0] >= 100) } : e))
    const [f] = run(few)
    expect(f.title).not.toMatch(/usually leaves/)
    expect(f.evidence['what it usually waits for (learned from its exits)']).toMatch(/^not learned: RIGHT_HANDOFF ended 2 times while enabled/)
  })
})

// The team's real logs from the 2025 robot's event: 64 from the match days + 14 from the practice day, read-only from the folder listed in
// tests/helpers/team-logs.ts, which also names the logs these tests pick out (F below).
const EVENT = teamPath(TEAM.event2025)
const F = (TEAM.event2025Files ?? {}) as Record<string, string> & { restartPieces: string[]; estopAtEnable: string[] }
const eventLogs = existsSync(EVENT) ? readdirSync(EVENT).filter((f) => f.endsWith('.wpilog')).sort() : []
const ROLES = ['restartPieces', 'estopAtEnable', 'estopLate', 'earlierRun', 'earlierRunBuild', 'handoffWait', 'heldFromAuto', 'carryOver', 'busDrop', 'odometryOutliers', 'collapse']
const haveEvent = eventLogs.length >= 78 && ROLES.every((r) => r in F)
if (!haveEvent) console.warn(`SKIPPED part of event-2025-rules.test.ts: list the 78 .wpilog files' folder (event2025) and event2025Files (${ROLES.join(', ')}) in ${TEAM_LOGS_FILE} to run it`)

describe.skipIf(!haveEvent)('the 2025 robot\'s event logs', () => {
  const read = (names: string[]) => analyzeFiles(names.map((n) => readInput(`${EVENT}/${n}`))).analyses
  const pick = (...names: string[]) => eventLogs.filter((n) => names.includes(n))
  const byName = (list: ReturnType<typeof read>, name: string) => list.find((a) => a.match.fileName === name)!

  it('each log alone: restart-mid-match fires only on one match\'s three pieces, emergency-stop only on one match and three practice-day runs', () => {
    const restart: string[] = [], estop: string[] = []
    for (const name of eventLogs) {
      const got = fired(read([name])[0].report)
      if (got.has('loop/restart-mid-match')) restart.push(name)
      if (got.has('comms/emergency-stop')) estop.push(name)
    }
    expect(restart).toEqual(F.restartPieces)
    expect(estop).toEqual([...F.estopAtEnable, F.estopLate].sort())
  }, 120_000)

  it('a match restarted in pieces, with the practice run before it: the gaps, the lost controller, and the auto\'s earlier run', () => {
    const list = read(pick(...F.restartPieces, F.earlierRun))
    const third = byName(list, F.restartPieces[2]).report.findings.find((f) => f.rule === 'loop/restart-mid-match')!
    expect(third.title).toMatch(/no controller on port 0 after the restart/)
    expect(third.evidence['between logs, program down or starting up (s, ±2)']).toBe('14.7, 48.7')
    const early = byName(list, F.restartPieces[0]).report.findings.find((f) => f.rule === 'auto/early-disable')!
    expect(early.evidence['its last earlier run']).toContain(`${F.earlierRun}, on the field, build ${F.earlierRunBuild} with uncommitted changes`)
  })

  it('stuck-state: a practice run waits for the arm\'s has-piece flag that never came; two more runs fire; two stay quiet', () => {
    const list = read(eventLogs.filter((n) => /_[qp]\d+\.wpilog$/.test(n)))
    const stuck = (name: string) => byName(list, name).report.findings.filter((f) => f.rule === 'mech/stuck-state')
    expect(stuck(F.handoffWait).map((f) => f.about)).toEqual(['RIGHT_HANDOFF'])
    expect(stuck(F.handoffWait)[0].title).toMatch(/for 107 s .* it usually leaves when Arm has game piece turns true, which never happened/)
    expect(stuck(F.earlierRun).map((f) => [f.about, f.evidence['seconds in it while enabled']])).toEqual([['SCORE_L4_RIGHT', 135]])
    expect(stuck(F.estopLate).map((f) => f.about)).toEqual(['SCORE_L4_LEFT'])
    // One held a score request set in auto but pressed nothing in its 23.4 s; the other's carry-over was 9 s.
    expect(stuck(F.heldFromAuto)).toEqual([])
    expect(stuck(F.carryOver)).toEqual([])
  })

  it('an e-stop 1.5 s before the end; a whole CANivore bus lost; vision outliers that are odometry', () => {
    const list = read(pick(F.estopLate, F.busDrop, F.odometryOutliers))
    expect(byName(list, F.estopLate).report.findings.find((f) => f.rule === 'comms/emergency-stop')!.title).toMatch(/with 1\.5 s of teleop left/)
    const can = byName(list, F.busDrop).report.findings.filter((f) => f.rule.startsWith('can/'))
    expect(can.map((f) => `${f.rule} ${f.about}`)).toEqual(['can/bus-dropout CANivore bus'])
    expect(can[0].evidence['seconds until every device was back']).toBe('58.7')
    const outliers = byName(list, F.odometryOutliers).report.findings.filter((f) => f.rule === 'vision/outliers')
    expect(outliers.map((f) => f.causes[0].id)).toEqual(['odometry', 'odometry'])
  })

  it('links: the bus drop\'s module and gyro alerts sit under it ("Using Sync Odometry" does not); a brownout under the collapse', () => {
    const list = read(pick(F.busDrop, F.collapse))
    const links = (name: string) => byName(list, name).report.findings.filter((f) => f.explainedBy).map((f) => `${f.rule}${f.about ? ` ${f.about}` : ''} ← ${f.explainedBy!.rule}`)
    expect(links(F.busDrop)).toEqual(['alerts/passthrough Missing Module Data ← can/bus-dropout', 'alerts/passthrough Missing Gyro Data ← can/bus-dropout'])
    expect(links(F.collapse)).toEqual(['power/brownout ← power/battery-collapse', 'power/margin ← power/brownout'])
  })
})
