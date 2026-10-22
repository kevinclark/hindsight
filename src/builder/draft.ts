/**
 * A draft robot profile from what the team already has: a match log, and optionally a robot snapshot and the robot
 * code folder. The draft says where each value came from; what no file can show is left for the student to confirm.
 */
import { readNumbers, readValues, type WpilogFile } from '../readers/wpilog.ts'
import { buildMatch } from '../match/match.ts'
import type { Snapshot, Device } from '../snapshot/snapshot.ts'
import { motorsFromLog, type LogMotor } from './motors.ts'
import { groupMotors } from './groups.ts'
import { codebaseOf, signalsFromLog } from './signals.ts'
import { matchByName, groupLimits } from './snapshot.ts'
import { toProfile, PROFILE_SCHEMA, type GroupJson, type MotorJson, type ProfileJson } from './json.ts'
import type { CodeHints } from './code-hints.ts'
import { idFromDeviceKey } from '../match/companion.ts'
import { firstText } from '../profiles/formats.ts'
import { applyCode } from './code-draft.ts'

/** What the builder couldn't settle from the files, for the confirm step. */
export interface Draft {
  json: ProfileJson
  /** Current keys seen but not read as motors, and log features v1 can't read. */
  notUsed: { key: string; why: string }[]
  limits: string[]
  /** Signals picked by their shape (the student confirms), with the other candidates. */
  guessed: { signal: string; key: string; alternatives: string[] }[]
  /** What the student should know about the files themselves: logs left out, what the code says the log lacks. */
  notes: string[]
  /** The notes, then draftWarnings on the draft's groups (which the builder recomputes as the student edits). */
  warnings: string[]
}

/**
 * What the student should look at before trusting the draft. A log that names only a few motors (a dashboard's pick,
 * or a robot that logs only its drive) would make the battery model and the main breaker's heating far too light.
 */
export function draftWarnings(groups: { name: string; groupedBy?: string; motors: unknown[] }[]): string[] {
  const motors = groups.reduce((n, g) => n + g.motors.length, 0)
  const out: string[] = []
  if (motors === 0) out.push('No motors found in this log: rules about motors and currents will be "not checked".')
  else if (motors < 4) out.push(`Only ${motors} motor${motors === 1 ? '' : 's'} found. If the robot has more, the total current (battery model, main breaker) will read too low.`)
  if (motors > 0 && !groups.some((g) => g.groupedBy === 'swerve')) out.push('No drive motors recognised (no swerve modules). If the drive motors log their currents, check their names below.')
  // Rules and findings name a group by its name, so two groups with one name would read as one.
  const names = groups.map((g) => g.name.trim().toLowerCase())
  const repeated = [...new Set(names.filter((n, i) => n && names.indexOf(n) !== i).map((n) => groups[names.indexOf(n)].name.trim()))]
  for (const n of repeated) out.push(`Two groups are called "${n}": give each group its own name, or move the motors into one group.`)
  if (groups.some((g) => !g.name.trim())) out.push('A group has no name: findings name a group by it.')
  return out
}

/** The rules a profile from files alone can't feed: what they need is listed so the student knows. */
export const NOT_INFERRED = [
  { what: 'zeroing mechanisms', rules: ['mech/zero-not-completed'] },
  { what: 'cameras', rules: ['vision/outliers', 'vision/stale'] },
  { what: 'motor groups that never stall, and their setpoint', rules: ['mech/stall'] },
  { what: 'motors paired with an absolute angle (slipChecks)', rules: ['mech/slip'] },
  { what: 'the what-if group (Power tab)', rules: [] as string[] },
]

/**
 * A logged CAN ID beside the motor's keys (`<motor>/MotorId`, `<motor>CanId`), or in the Hindsight companion's Device
 * key (`<motor>/Device`, `<motor>Device`: "Any/TalonFX/15"), when the code logs one.
 */
function loggedCanId(log: WpilogFile, m: LogMotor): number | undefined {
  for (const key of [`${m.path}/MotorId`, `${m.path}/CanId`, `${m.path}/DeviceId`, `${m.path}MotorId`, `${m.path}CanId`]) {
    const v = readValues<number | bigint>(log, key)?.v
    const last = v?.at(-1)
    if (last !== undefined && Number.isInteger(Number(last))) return Number(last)
  }
  for (const key of [`${m.path}/Device`, `${m.path}Device`]) {
    const last = readValues<string>(log, key)?.v.at(-1)
    const id = typeof last === 'string' ? idFromDeviceKey(last) : undefined
    if (id !== undefined) return id
  }
  return undefined
}

/** One dropped log. Several logs of one robot draft better than one: a key logged only in some matches is still found. */
export interface DraftLog { log: WpilogFile; fileName: string }

/** The motors of several logs: one per path, each key from the first log that has it. */
function mergeMotors(found: ReturnType<typeof motorsFromLog>[]): ReturnType<typeof motorsFromLog> {
  const byPath = new Map<string, LogMotor>()
  for (const f of found) for (const m of f.motors) byPath.set(m.path, { ...m, ...byPath.get(m.path) })
  const seen = new Set<string>()
  const once = <T>(xs: T[], key: (x: T) => string) => xs.filter((x) => !seen.has(key(x)) && !!seen.add(key(x)))
  return {
    motors: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    notUsed: once(found.flatMap((f) => f.notUsed), (n) => `n ${n.key}`).filter((n) => ![...byPath.values()].some((m) => m.current === n.key || m.supplyCurrent === n.key || m.statorCurrent === n.key)),
    limits: once(found.flatMap((f) => f.limits), (l) => `l ${l}`),
  }
}

/** Each signal from the first log that has it (the framework's fixed names are the same in all). */
function mergeSignals(sigs: ReturnType<typeof signalsFromLog>[]): ReturnType<typeof signalsFromLog> {
  const [first, ...rest] = sigs
  const out = structuredClone(first)
  for (const s of rest) {
    for (const k of Object.keys(out.signals) as (keyof typeof out.signals)[]) {
      const v = out.signals[k]
      if ((v === '' || (Array.isArray(v) && v.length === 0)) && s.signals[k] !== v) {
        ;(out.signals as Record<string, unknown>)[k] = s.signals[k]
        if (s.guessed.includes(k) && !out.guessed.includes(k)) out.guessed.push(k)
        if (s.alternatives[k]) out.alternatives[k] = s.alternatives[k]
      }
    }
    for (const k of Object.keys(out.battery) as (keyof typeof out.battery)[]) out.battery[k] = [...new Set([...out.battery[k], ...s.battery[k]])]
    out.otherDevices = [...out.otherDevices, ...s.otherDevices.filter((d) => !out.otherDevices.some((o) => o.connected === d.connected))]
    out.signals.alertGroups = [...new Set([...out.signals.alertGroups, ...s.signals.alertGroups])].sort()
    out.codebase ||= s.codebase
  }
  return out
}

export function draftProfile(input: { logs: DraftLog[]; snapshot?: Snapshot; hints?: CodeHints }): Draft {
  if (input.logs.length === 0) throw new Error('drop a match log (.wpilog) first')
  // The latest log names the code (branch and commit) and measures the game; the others only add keys. Latest by the
  // robot's wall clock, else by file name (AdvantageKit's and DataLogManager's names start with the date).
  const sorted = [...input.logs].sort((a, b) => wallClock(b.log) - wallClock(a.log) || b.fileName.localeCompare(a.fileName))
  // Only logs of the latest log's robot: logs of another codebase (last year's robot) would merge two robots into one.
  const robot = codebaseOf(sorted[0].log)
  const logs = sorted.filter((l) => codebaseOf(l.log) === robot)
  const others = sorted.filter((l) => !logs.includes(l))
  const { log, fileName } = logs.find((l) => l.log.entries.has('/DriverStation/Enabled') || l.log.entries.has('DS:enabled')) ?? logs[0]
  const found = mergeMotors(logs.map((l) => motorsFromLog(l.log)))
  const groups = groupMotors(found.motors)
  const motorKeys = new Set(found.motors.flatMap((m) => [m.supplyCurrent, m.statorCurrent, m.current, m.velocity, m.connected, m.temperature].filter((k): k is string => !!k)))
  const own = signalsFromLog(log, motorKeys)
  const sig = mergeSignals([own, ...logs.filter((l) => l.log !== log).map((l) => signalsFromLog(l.log, motorKeys))])
  sig.code = own.code

  const motorGroups: GroupJson[] = groups.map((g) => ({
    name: g.name,
    groupedBy: g.evidence,
    // A leader and its followers run one loop: ticked, shown as the builder's suggestion until the student confirms.
    ...(g.evidence === 'leader/follower' ? { sameLoop: true, sameLoopSuggested: true } : {}),
    motors: g.motors.map(({ name, motor }): MotorJson => {
      const id = logs.map((l) => loggedCanId(l.log, motor)).find((x) => x !== undefined)
      return {
        name,
        logPath: motor.path,
        ...(motor.supplyCurrent ? { supplyCurrent: motor.supplyCurrent } : {}),
        ...(motor.statorCurrent ? { statorCurrent: motor.statorCurrent } : {}),
        ...(motor.current ? { current: motor.current } : {}),
        ...(motor.velocity ? { velocity: motor.velocity } : {}),
        ...(motor.connected ? { connected: motor.connected } : {}),
        ...(motor.temperature ? { temperature: motor.temperature } : {}),
        ...(id !== undefined ? { canId: id, canIdFrom: 'log' as const } : {}),
      }
    }),
  }))

  const json: ProfileJson = {
    schema: PROFILE_SCHEMA,
    name: sig.codebase || fileName.replace(/\.wpilog$/i, ''),
    codebase: sig.codebase,
    code: sig.code,
    game: measuredGame(log, fileName, sig),
    signals: sig.signals,
    battery: sig.battery,
    otherDevices: sig.otherDevices,
    motorGroups,
    whatIfGroup: '',
    zeroing: [],
    cameras: [],
    builtFrom: { log: logs.map((l) => l.fileName).join(', '), at: new Date().toISOString() },
  }
  // The code's word on kinds, IDs, groups and limits; then a snapshot's, which says what the robot actually holds.
  const fromCode = input.hints ? applyCode(json, input.hints, log, /uncom+itted/i.test(firstText(log, sig.signals.gitDirty))) : []
  if (input.snapshot) applySnapshot(json, input.snapshot)
  if (input.hints) json.builtFrom = { ...json.builtFrom!, code: input.hints.sha ?? 'unknown commit' }
  const guessed = sig.guessed.map((s) => ({ signal: s, key: sig.signals[s] as string, alternatives: sig.alternatives[s] ?? [] }))
  const leftOut = others.length ? [`${others.length} log${others.length === 1 ? ' is' : 's are'} from another robot (${[...new Set(others.map((l) => codebaseOf(l.log) || 'no code name'))].join(', ')}) and ${others.length === 1 ? 'was' : 'were'} left out: ${others.map((l) => l.fileName).join(', ')}.`] : []
  const notes = [...leftOut, ...fromCode]
  return { json, notUsed: found.notUsed, limits: found.limits, guessed, notes, warnings: [...notes, ...draftWarnings(json.motorGroups)] }
}

/** The robot's wall clock at the end of the log (µs), or 0 when the log never had it set. */
function wallClock(log: WpilogFile): number {
  for (const key of ['/SystemStats/EpochTimeMicros', 'systemTime']) {
    const v = readNumbers(log, key)?.v
    if (v && v.length) return v[v.length - 1]
  }
  return 0
}

/**
 * Carry what the student confirmed into a new draft (another log was dropped): each motor's name, CAN ID and
 * supply-or-stator choice by its place in the log, and a group's name and "same loop" when it has the same motors.
 */
export function carryConfirmations(from: ProfileJson, to: ProfileJson): void {
  const old = new Map(allMotors(from).filter(({ motor }) => motor.logPath).map(({ motor }) => [motor.logPath!, motor]))
  for (const { motor } of allMotors(to)) {
    const o = motor.logPath ? old.get(motor.logPath) : undefined
    if (!o) continue
    motor.name = o.name
    if (o.canId !== undefined && motor.canIdFrom !== 'log') { motor.canId = o.canId; motor.bus = o.bus; motor.canIdFrom = o.canIdFrom }
    if (motor.current && !o.current) {
      if (o.supplyCurrent === motor.current) { motor.supplyCurrent = motor.current; delete motor.current }
      else if (o.statorCurrent === motor.current) { motor.statorCurrent = motor.current; delete motor.current }
    }
  }
  const members = (g: GroupJson) => g.motors.map((m) => m.logPath ?? m.name).sort().join('\n')
  for (const g of to.motorGroups) {
    const o = from.motorGroups.find((x) => members(x) === members(g))
    if (!o) continue
    g.name = o.name
    if (o.sameLoop !== undefined) g.sameLoop = o.sameLoop
    if (o.sameLoopSuggested) g.sameLoopSuggested = true; else delete g.sameLoopSuggested
  }
  to.name = from.name
  if (from.game) to.game = from.game
}

/** Auto and teleop lengths measured from this log, the way a log no profile fits is read (match/match.ts). */
function measuredGame(log: WpilogFile, fileName: string, sig: ReturnType<typeof signalsFromLog>): ProfileJson['game'] {
  const probe = toProfile({ name: 'probe', motorGroups: [], signals: sig.signals })
  const match = buildMatch(fileName, log, probe, { how: 'given', note: null, fit: null, misfit: true })
  return { ...match.profile.game, name: `measured from ${fileName}` }
}

/** Every motor with its group, in order. */
export const allMotors = (json: ProfileJson) => json.motorGroups.flatMap((g) => g.motors.map((m) => ({ group: g, motor: m })))

/**
 * Fill CAN IDs and buses from a snapshot: a logged ID first, then Tuner X names, then the only one left. Then each
 * group's limits from the Talon FX it now names. Motors the student already set are kept.
 */
export function applySnapshot(json: ProfileJson, snapshot: Snapshot): void {
  const talons = snapshot.devices.filter((d) => d.isMotor)
  const motors = allMotors(json).map((x) => x.motor)
  const taken = new Set<string>()
  const deviceFor = (m: MotorJson) => (m.canId === undefined ? undefined : talons.find((d) => d.id === m.canId && (m.bus === undefined || d.bus === m.bus)))
  for (const m of motors) { const d = deviceFor(m); if (d) { taken.add(d.key); m.bus = d.bus } }
  const open = () => motors.filter((m) => m.canId === undefined)
  for (const { path, device } of matchByName(open().map((m) => m.logPath ?? m.name), { ...snapshot, devices: talons.filter((d) => !taken.has(d.key)) })) {
    const m = open().find((x) => (x.logPath ?? x.name) === path)
    if (!m) continue
    m.canId = device.id; m.bus = device.bus; m.canIdFrom = 'snapshot'; taken.add(device.key)
  }
  const leftDevices = talons.filter((d) => !taken.has(d.key))
  if (open().length === 1 && leftDevices.length === 1) {
    const m = open()[0], d = leftDevices[0]
    m.canId = d.id; m.bus = d.bus; m.canIdFrom = 'snapshot'
  }
  refreshLimits(json, snapshot)
}

/** The student picked a Talon FX for a motor (or none). */
export function setDevice(json: ProfileJson, snapshot: Snapshot | null, motor: MotorJson, device: Pick<Device, 'id' | 'bus'> | null): void {
  if (device) { motor.canId = device.id; motor.bus = device.bus; motor.canIdFrom = 'you' } else { delete motor.canId; delete motor.bus; delete motor.canIdFrom }
  if (snapshot) refreshLimits(json, snapshot)
}

/**
 * Each group's limits from its motors' applied ones, when they agree (else the reason, for the builder to show). Limits
 * a profile.json carried from the robot code (any `where` but "as running on the robot") are kept: the snapshot view
 * compares those with the robot.
 */
export function refreshLimits(json: ProfileJson, snapshot: Snapshot): Map<GroupJson, string> {
  const problems = new Map<GroupJson, string>()
  let fromSnapshot = false
  for (const g of json.motorGroups) {
    if (g.limits && !g.limits.where.startsWith('as running')) continue
    const devices = g.motors.map((m) => snapshot.devices.find((d) => d.isMotor && d.id === m.canId && (m.bus === undefined || d.bus === m.bus))).filter((d): d is Device => !!d)
    if (devices.length < g.motors.length) { problems.set(g, `${g.motors.length - devices.length} of its ${g.motors.length} motors aren't matched to a Talon FX in the snapshot yet`); if (g.limits?.where.startsWith('as running')) delete g.limits; continue }
    const r = groupLimits(devices, snapshot)
    if ('limits' in r) { g.limits = r.limits; fromSnapshot = true }
    else { problems.set(g, r.problem); delete g.limits }
  }
  if (fromSnapshot) json.limitsFrom = { snapshotTakenAt: snapshot.takenAt }
  else delete json.limitsFrom
  return problems
}
