/**
 * Foresight's checks over a robot snapshot (src/snapshot/): what the CTRE devices themselves say, which no log holds.
 * They tick the pit checklist's "licensed and ID'd", "CANcoder offsets" and "swerve ratio" lines, and the applied
 * current limits.
 *
 * The page never talks to the Phoenix diagnostic server: tools/robot-snapshot.py reads it (five allowlisted read
 * requests, never blink or Clear Faults, which wipe sticky faults) and a person drops its snapshot.json here. A
 * snapshot only counts when it was taken after this run of the robot code had settled: the code applies its configs
 * at start-up, so a snapshot from before then says nothing about what the devices run now.
 *
 * Every check here starts amber and has no proof yet (proven.ts): no snapshot of 8033's robot has been taken, so none
 * has been backtested or has caught a real fault. Response shapes are still CTRE's simulator's (snapshot.ts).
 */
import type { Report, SkippedRule } from '../rules/index.ts'
import type { Finding } from '../rules/types.ts'
import type { RobotProfile, SnapshotExpectations } from '../profiles/types.ts'
import { busLabel, configOf, parseBool, parseNumber, type Config, type Device, type Snapshot } from '../snapshot/snapshot.ts'
import { fieldText, inventory, limitsReport } from '../snapshot/report.ts'

type Rule = 'snapshot/devices' | 'snapshot/licensed' | 'snapshot/cancoder-offsets' | 'snapshot/swerve-ratio' | 'snapshot/current-limits'
export const SNAPSHOT_RULES: Rule[] = ['snapshot/devices', 'snapshot/licensed', 'snapshot/cancoder-offsets', 'snapshot/swerve-ratio', 'snapshot/current-limits']

/** Why these checks are amber whatever they find (shown as each finding's proof). */
export const SNAPSHOT_PROOF = 'amber: no snapshot of our robot has been checked yet, so this check has no backtest and has never caught a real fault'

/** What a person does to get a snapshot Foresight will use. */
export const TAKE_SNAPSHOT = 'run python3 tools/robot-snapshot.py (robot on, tethered, not enabled) and drop its snapshot.json on this page'

/** A MagnetOffset read back within this many rotations of the code's (0.36°) is the same offset. */
export const OFFSET_TOLERANCE = 0.001
/** A ratio read back within this fraction of the code's is the same ratio (a wheel radius 1 % off is a change). */
export const RATIO_TOLERANCE = 0.001

/**
 * The snapshot as loaded, and when this run of the robot code started on the laptop's clock (ms), if known.
 * `codeStartFrom`: 'first value' when the robot sent no metadata, so the "start" is only the first value Foresight saw.
 */
export interface SnapshotInput {
  snapshot: Snapshot | null
  codeStartWallMs: number | null
  codeStartFrom?: 'metadata' | 'first value' | null
}

const RULE_TEXT: Record<Rule, { meaning: string; causes: Finding['causes']; nextStep: string }> = {
  'snapshot/devices': {
    meaning: 'The CAN bus doesn\'t hold the devices the robot code expects, each on its own ID. A missing or duplicated device means a mechanism, encoder or the gyro won\'t work in the match.',
    causes: [
      { id: 'unplugged', cause: 'A device is unpowered or its CAN wiring is broken or unplugged', look: 'the device\'s LED, its CAN connectors and the wires either side of it' },
      { id: 'replaced', cause: 'A replaced device still has its factory ID (0) or the old one\'s ID was not copied over', look: 'the device in Phoenix Tuner X: its ID and name' },
      { id: 'profile', cause: 'The robot code changed its CAN IDs and the robot profile wasn\'t updated', look: 'the IDs in the robot code against the profile' },
    ],
    nextStep: 'Find the device on the robot, fix its wiring or give it the ID the code uses in Phoenix Tuner X (don\'t press Clear Faults or blink until a snapshot is saved), then take a new snapshot.',
  },
  'snapshot/licensed': {
    meaning: 'A device reports it was asked for a Phoenix Pro feature (e.g. a steer motor fused with its CANcoder) without a Pro licence. It falls back to a simpler mode, so it doesn\'t behave as the code expects.',
    causes: [
      { id: 'licence', cause: 'The device, or the CANivore it is on, has no Pro licence for this season', look: 'the device\'s licences in Phoenix Tuner X' },
      { id: 'replaced', cause: 'A replaced device was never licensed', look: 'its serial number against the team\'s licence list' },
    ],
    nextStep: 'Licence the device (or its CANivore) in Phoenix Tuner X, or ask the software lead whether the code should stop using the Pro feature.',
  },
  'snapshot/cancoder-offsets': {
    meaning: 'A CANcoder is not running the offset the robot code sets, or a motor reads the wrong CANcoder. That swerve module (or mechanism) then points the wrong way when the robot drives.',
    causes: [
      { id: 'apply', cause: 'The code\'s config apply failed at start-up, so the device kept an older offset', look: 'the robot code\'s console for CANcoder or config errors at start-up' },
      { id: 'tuner', cause: 'Someone changed the offset or the remote sensor ID in Phoenix Tuner X', look: 'ask who last used Tuner X on the robot; restarting the robot code puts the code\'s values back' },
      { id: 'swapped', cause: 'A CANcoder was replaced or swapped between modules and has another ID', look: 'the CANcoder\'s ID in Tuner X against the module it sits on' },
    ],
    nextStep: 'Restart the robot code (or redeploy) and take a new snapshot; if it still differs, find which device changed with the software lead before the robot drives.',
  },
  'snapshot/swerve-ratio': {
    meaning: 'A swerve motor isn\'t running the gear ratio the robot code sets, so the robot\'s idea of how far and how fast it drives or steers is wrong.',
    causes: [
      { id: 'apply', cause: 'The code\'s config apply failed at start-up, so the motor kept an older ratio', look: 'the robot code\'s console for config errors at start-up' },
      { id: 'tuner', cause: 'Someone changed the ratio in Phoenix Tuner X', look: 'ask who last used Tuner X on the robot' },
      { id: 'profile', cause: 'The robot code changed its gearing or wheel size and the robot profile wasn\'t updated', look: 'the gear ratio and wheel radius in the swerve constants against the profile' },
    ],
    nextStep: 'Restart the robot code (or redeploy) and take a new snapshot; if the code itself changed the ratio, the software lead updates the robot profile.',
  },
  'snapshot/current-limits': {
    meaning: 'A motor isn\'t running the current limits the robot code sets. A supply limit higher than intended (or off) lets the robot pull the battery down harder; a lower one makes the mechanism weaker.',
    causes: [
      { id: 'apply', cause: 'The code\'s config apply failed at start-up, so the motor kept older limits', look: 'the robot code\'s console for config errors at start-up' },
      { id: 'tuner', cause: 'Someone changed the limit in Phoenix Tuner X', look: 'ask who last used Tuner X on the robot; restarting the robot code puts the code\'s values back' },
      { id: 'profile', cause: 'The robot code changed the limit and the robot profile wasn\'t updated', look: 'the limit in the code (the "where" below) against the profile' },
    ],
    nextStep: 'Restart the robot code (or redeploy) and take a new snapshot; if the code changed the limit on purpose, the software lead updates the robot profile.',
  },
}

function finding(rule: Rule, about: string, title: string, evidence: Finding['evidence'], severity: Finding['severity'] = 'warning'): Finding {
  const text = RULE_TEXT[rule]
  return { rule, severity, title, time: null, matchTime: null, when: null, about, key: `${rule}:${about}`, evidence, meaning: text.meaning, causes: text.causes, nextStep: text.nextStep }
}

const MODEL: Record<SnapshotExpectations['devices'][number]['model'], RegExp> = { CANcoder: /^CANcoder/i, 'Pigeon 2': /^Pigeon ?2/i }

/** The one device of this model on this ID, or why there isn't one. */
function findDevice(snapshot: Snapshot, model: RegExp, id: number): Device | string {
  const found = snapshot.devices.filter((d) => model.test(d.model) && d.id === id)
  if (found.length === 0) return 'not on the bus'
  if (found.length > 1) return `on more than one bus (${found.map((d) => busLabel(d.bus)).join(', ')})`
  if (found[0].count > 1) return `${found[0].count} devices share this ID (serials ${found[0].serials.join(', ')})`
  return found[0]
}

const findMotor = (snapshot: Snapshot, id: number) => findDevice(snapshot, /^Talon FX/i, id)

/** A config by its signal name, trying each spelling (the CANcoder's offset is CANCoder_MagnetOffset in Phoenix 26.3.0). */
const configNamed = (device: Device, ...names: string[]): Config | undefined => names.map((n) => configOf(device, n)).find(Boolean)

const round = (x: number, digits = 4) => +x.toFixed(digits)
/** The difference between two angles in rotations, wrapped into -0.5..0.5. */
const turnDifference = (a: number, b: number) => ((((a - b) % 1) + 1.5) % 1) - 0.5

/** Collects one check's findings and the parts it couldn't read, then reports it as run, partly run or not run. */
class Check {
  findings: Finding[] = []
  unread: string[] = []
  checked = 0
  readonly rule: Rule
  constructor(rule: Rule) { this.rule = rule }
  fire(about: string, title: string, evidence: Finding['evidence'], severity?: Finding['severity']) { this.findings.push(finding(this.rule, about, title, evidence, severity)) }
  done(skipped: SkippedRule[], nothing: string): Finding[] {
    if (this.checked === 0 && this.findings.length === 0) skipped.push({ rule: this.rule, reason: this.unread.length ? this.unread.join('; ') : nothing })
    else if (this.unread.length) skipped.push({ rule: this.rule, reason: `partly checked; ${this.unread.join('; ')}` })
    return this.findings
  }
}

function devicesCheck(snapshot: Snapshot, profile: RobotProfile, expected: SnapshotExpectations | undefined): Check {
  const c = new Check('snapshot/devices')
  const rows = inventory(snapshot, profile)
  for (const row of rows) {
    const motor = row.motor ? `${row.motor.name} (Talon FX ${row.motor.canId ?? '?'})` : ''
    if (row.status === 'found') c.checked++
    else if (row.status === 'no-can-id') c.unread.push(`${row.motor!.name} has no CAN ID in the profile`)
    else if (row.status === 'missing') c.fire(row.motor!.name, `${motor} is not on the CAN bus`, { problem: row.note })
    else if (row.status === 'ambiguous') c.fire(row.motor?.name ?? `${row.devices[0].model} ${row.devices[0].id}`, row.motor ? `${motor}: its CAN ID is used more than once` : `Duplicate CAN ID: ${row.devices[0].model} ${row.devices[0].id}`, { problem: row.note })
    else if (row.status === 'extra') c.fire(`Talon FX ${row.devices[0].id} on the ${busLabel(row.devices[0].bus)}`, `Talon FX ${row.devices[0].id} on the ${busLabel(row.devices[0].bus)} is not in the robot profile`, { problem: row.note, serial: row.devices[0].serial })
  }
  const listed = new Set<string>()
  for (const want of expected?.devices ?? []) {
    const found = findDevice(snapshot, MODEL[want.model], want.canId)
    if (typeof found === 'string') c.fire(want.name, `${want.name} (${want.model} ${want.canId}) is ${found === 'not on the bus' ? 'not on the CAN bus' : found}`, { expected: `${want.model} on CAN ID ${want.canId}`, found })
    else { c.checked++; listed.add(found.key) }
  }
  if (!expected) c.unread.push('the robot profile lists no CANcoders or gyro, so only the motors were checked')
  // Other CTRE devices the profile doesn't list: context only, since a device the profile never needed (a CANdle, a
  // power board) isn't a fault.
  const others = rows.filter((r) => r.status === 'other' && !listed.has(r.devices[0].key))
  if (expected && others.length) c.fire('other devices', `${others.length} other CTRE device${others.length === 1 ? '' : 's'} on the bus that the profile doesn't list`, Object.fromEntries(others.map((r) => [`${r.devices[0].model} ${r.devices[0].id}`, busLabel(r.devices[0].bus)])), 'info')
  return c
}

/** Phoenix raises a "used a Pro feature without a licence" fault (e.g. Fault_UnlicensedFeatureInUse, a fused CANcoder unlicensed). */
const UNLICENSED = /^(Sticky)?Fault_.*Unlicensed/i

/**
 * Only the devices the profile expects (its motors, CANcoders and gyro): another device (a CANdle, a power board) may
 * not answer a self-test at all, and would leave the check partly done for good.
 */
function licensedCheck(snapshot: Snapshot, profile: RobotProfile, expected: SnapshotExpectations | undefined): Check {
  const c = new Check('snapshot/licensed')
  const wanted = [
    ...profile.motorGroups.flatMap((g) => g.motors).filter((m) => m.canId !== undefined).map((m) => ({ name: m.name, model: /^Talon FX/i, id: m.canId! })),
    ...(expected?.devices ?? []).map((d) => ({ name: d.name, model: MODEL[d.model], id: d.canId })),
  ]
  const unread: string[] = []
  for (const want of wanted) {
    const device = findDevice(snapshot, want.model, want.id)
    if (typeof device === 'string') continue // snapshot/devices reports it
    const signals = device.signals?.filter((s) => UNLICENSED.test(s.name)) ?? []
    if (!device.selfTest || signals.length === 0) { unread.push(device.skipped ? `${want.name} (not read: ${device.skipped})` : want.name); continue }
    const values = signals.map((s) => { const row = device.selfTest![String(s.id)] ?? device.selfTest![s.name]; return { name: s.name, value: row === undefined ? null : parseBool(row.Value) } })
    const set = values.filter((v) => v.value === true)
    // A sticky fault says it happened since faults were last cleared; only a live one says it is happening now.
    const now = set.some((v) => !/^Sticky/i.test(v.name))
    if (set.length) c.fire(want.name, `${want.name} ${now ? 'is using' : 'used'} a Pro feature without a licence${now ? '' : ' (a sticky fault: since faults were last cleared)'}`, { faults: set.map((v) => v.name).join(', '), 'Pro licensed (getdevices)': device.pro ? 'yes' : 'no', device: `${device.model} ${device.id} on the ${busLabel(device.bus)}` })
    else if (values.some((v) => v.value === null)) unread.push(`${want.name} (licence faults unreadable)`)
    else c.checked++
  }
  if (unread.length) c.unread.push(`no licence faults read from ${unread.length === wanted.length ? `any of the ${wanted.length} devices` : `${unread.slice(0, 3).join(', ')}${unread.length > 3 ? ` and ${unread.length - 3} more` : ''}`} (fault names as in Phoenix 26.3.0, not yet seen on a real robot)`)
  return c
}

function offsetsCheck(snapshot: Snapshot, expected: SnapshotExpectations | undefined): Check {
  const c = new Check('snapshot/cancoder-offsets')
  for (const want of expected?.devices ?? []) {
    if (want.model !== 'CANcoder') continue
    const where: Finding['evidence'] = want.where ? { 'set in the code': want.where } : {}
    if (want.magnetOffset !== undefined) {
      const device = findDevice(snapshot, MODEL.CANcoder, want.canId)
      const applied = typeof device === 'string' ? null : parseNumber(configNamed(device, 'CANCoder_MagnetOffset', 'Config_MagnetOffset')?.value)
      if (typeof device === 'string') c.unread.push(`${want.name}: ${device}`)
      else if (applied === null) c.unread.push(`${want.name}: its magnet offset wasn't read`)
      else {
        const off = turnDifference(applied, want.magnetOffset)
        if (Math.abs(off) > OFFSET_TOLERANCE) c.fire(want.name, `${want.name}'s offset is ${round(applied)} rotations, not the code's ${round(want.magnetOffset)} (${round(off * 360, 1)}° off)`, { 'offset applied (rotations)': round(applied), 'offset in the code (rotations)': round(want.magnetOffset), 'difference (°)': round(off * 360, 1), ...where })
        else c.checked++
      }
    }
    if (want.readBy === undefined) continue
    const motor = findMotor(snapshot, want.readBy)
    if (typeof motor === 'string') { c.unread.push(`Talon FX ${want.readBy} (reads ${want.name}): ${motor}`); continue }
    const remote = parseNumber(configOf(motor, 'Config_FeedbackRemoteSensorID')?.value)
    if (remote === null) c.unread.push(`Talon FX ${want.readBy}: its remote sensor ID wasn't read`)
    else if (remote !== want.canId) c.fire(`${want.name} reader`, `Talon FX ${want.readBy} reads CANcoder ${remote}, not ${want.name} (${want.canId})`, { 'remote sensor ID applied': remote, 'in the code': want.canId, ...where })
    else c.checked++
  }
  return c
}

const sameRatio = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-4, RATIO_TOLERANCE * Math.abs(b))

function ratioCheck(snapshot: Snapshot, profile: RobotProfile, expected: SnapshotExpectations | undefined): Check {
  const c = new Check('snapshot/swerve-ratio')
  for (const want of expected?.ratios ?? []) {
    const group = profile.motorGroups.find((g) => g.name === want.group)
    if (!group) { c.unread.push(`no motor group "${want.group}" in the profile`); continue }
    const fields = ([['Config_SensorToMechanismRatio', 'sensor-to-mechanism', want.sensorToMechanism], ['Config_RotorToSensorRatio', 'rotor-to-sensor', want.rotorToSensor]] as const).filter(([, , v]) => v !== undefined)
    const wrong: { motor: string; applied: string }[] = []
    for (const motor of group.motors) {
      const device = motor.canId === undefined ? 'no CAN ID in the profile' : findMotor(snapshot, motor.canId)
      if (typeof device === 'string') { c.unread.push(`${motor.name}: ${device}`); continue }
      for (const [signal, label, value] of fields) {
        const applied = parseNumber(configOf(device, signal)?.value)
        if (applied === null) c.unread.push(`${motor.name}: its ${label} ratio wasn't read`)
        else if (!sameRatio(applied, value!)) wrong.push({ motor: motor.name, applied: `${label} ${round(applied)}` })
        else c.checked++
      }
    }
    const code = fields.map(([, label, v]) => `${label} ${round(v!)}`).join(', ')
    const who = new Set(wrong.map((w) => w.motor))
    if (wrong.length) c.fire(want.group, `${want.group}: ${who.size === 1 ? `${wrong[0].motor} runs` : `${who.size} motors run`} another ratio than the code's (${code})`, { 'in the code': code, applied: wrong.map((w) => `${w.motor}: ${w.applied}`).join('; '), 'set in the code': want.where })
  }
  if (!expected?.ratios.length) c.unread.push('the robot profile has no swerve ratios')
  return c
}

function limitsCheck(snapshot: Snapshot, profile: RobotProfile): Check {
  const c = new Check('snapshot/current-limits')
  for (const group of limitsReport(snapshot, profile).groups) {
    for (const m of group.motors) {
      if (m.status === 'ok') c.checked++
      else if (m.status !== 'differs') c.unread.push(`${m.motor}: ${m.status === 'not-on-bus' ? 'not on the bus' : m.status === 'no-configs' ? 'its configs weren\'t read' : m.status === 'unreadable' ? 'a limit was unreadable' : m.status === 'ambiguous' ? 'its CAN ID is used more than once' : 'no CAN ID in the profile'}`)
    }
    const differs = group.motors.filter((m) => m.status === 'differs')
    if (!differs.length) continue
    const fields = differs.flatMap((m) => m.fields.filter((f) => f.ok === false).map((f) => `${m.motor}: ${f.label} ${fieldText(f, 'applied')} (code: ${fieldText(f, 'expected')})`))
    const supplyOff = differs.some((m) => m.supplyOff === 'unexpected')
    c.fire(group.group, `${group.group}: ${differs.length === 1 ? differs[0].motor + ' runs' : `${differs.length} motors run`} other current limits than the code sets${supplyOff ? ' (supply limit off)' : ''}`, { differs: fields.join('; '), 'set in the code': group.where })
  }
  return c
}

/** Why the snapshot can't be used for this run of the robot code, or null when it can. */
export function snapshotNotUsable(input: SnapshotInput | undefined, profile: RobotProfile, settleSeconds: number): string | null {
  const snapshot = input?.snapshot
  if (!snapshot) return `no robot snapshot: ${TAKE_SNAPSHOT}`
  const taken = Date.parse(snapshot.takenAt)
  if (!Number.isFinite(taken)) return `the snapshot has no readable time (${snapshot.takenAt})`
  if (input!.codeStartWallMs === null) return 'can\'t tell when the robot code started, so can\'t tell whether the snapshot is from this run of it'
  const settled = input!.codeStartWallMs + settleSeconds * 1000
  if (taken < settled && input!.codeStartFrom === 'first value') return 'the robot sent no start-up metadata, so Foresight only knows the code was running when it connected: take a new snapshot now that it is connected'
  if (taken < settled) return `the snapshot was taken ${taken < input!.codeStartWallMs ? 'before the robot code last started' : `in the first ${settleSeconds} s after the robot code started`}, so it may not show what the devices run now: take a new one`
  const ids = profile.motorGroups.flatMap((g) => g.motors).map((m) => m.canId).filter((id) => id !== undefined)
  const talons = new Set(snapshot.devices.filter((d) => d.isMotor).map((d) => d.id))
  if (ids.length && !ids.some((id) => talons.has(id))) return `none of the ${ids.length} motor IDs in "${profile.name}" is on the snapshot's bus: is it from another robot?`
  return null
}

/**
 * Run the snapshot checks into a report (in place): findings, plus every check that couldn't run and why. A snapshot
 * counts only when taken `settleSeconds` or more after the robot code started (its configs are applied by then).
 * Returns whether the snapshot was used.
 */
export function addSnapshotChecks(report: Report, input: SnapshotInput | undefined, profile: RobotProfile, settleSeconds: number): boolean {
  const why = snapshotNotUsable(input, profile, settleSeconds)
  if (why) { report.skipped.push(...SNAPSHOT_RULES.map((rule) => ({ rule, reason: why }))); return false }
  const snapshot = input!.snapshot!
  const expected = profile.foresight?.snapshot
  const incomplete = snapshot.stopped ? ` (the snapshot stopped early: ${snapshot.stopped.reason})` : ''
  const checks = [devicesCheck(snapshot, profile, expected), licensedCheck(snapshot, profile, expected), offsetsCheck(snapshot, expected), ratioCheck(snapshot, profile, expected), limitsCheck(snapshot, profile)]
  for (const check of checks) report.findings.push(...check.done(report.skipped, `nothing to check${incomplete}`))
  return true
}

/** The Foresight checks whose findings are about one watched device (named as WatchedDeviceView names it). */
const WATCHED_DEVICE_RULES = new Set(['can/device-dropout', 'can/device-rebooted', 'foresight/sticky-faults'])

/**
 * The snapshot's bus for a bus name the companion logs: "rio" is the snapshot's "" (the roboRIO's bus); "Any"
 * (CANBus("*")) is the snapshot's one CANivore when it has exactly one, else it can't be told. Other names as they are.
 */
export function snapshotBusFor(snapshot: Snapshot, bus: string): string | null {
  if (bus === 'rio') return ''
  if (bus !== 'Any') return bus
  const canivores = [...new Set(snapshot.devices.map((d) => d.bus).filter((b) => b !== ''))]
  return canivores.length === 1 ? canivores[0] : null
}

/**
 * Is this server model (snapshot.ts: "Talon FX vers. C", "CANCoder vers. H", "Pigeon 2") the companion's model
 * (TalonFX, CANcoder, Pigeon2)? The model name, spaces dropped and case ignored, must start the server's, followed by
 * nothing or its "vers." suffix, so TalonFX is not Talon FXS.
 */
export function sameModel(serverModel: string, companionModel: string): boolean {
  const server = serverModel.replace(/\s+/g, '').toLowerCase()
  const model = companionModel.toLowerCase()
  return server.startsWith(model) && /^(vers\..*)?$/.test(server.slice(model.length))
}

/** The snapshot's device for a watched device (same bus, model and ID), or why there isn't one. */
export function snapshotDeviceFor(snapshot: Snapshot, w: { bus: string; model: string; id: number }): Device | string {
  const bus = snapshotBusFor(snapshot, w.bus)
  if (bus === null) return `can't tell which bus: the robot code logs it on CANBus("*") and the snapshot has ${snapshot.devices.some((d) => d.bus !== '') ? 'more than one CANivore' : 'no CANivore'}`
  const found = snapshot.devices.find((d) => d.bus === bus && d.id === w.id && sameModel(d.model, w.model))
  return found ?? `not on the snapshot's ${busLabel(bus)}`
}

/**
 * Adds what the snapshot says about each watched device a finding is about (its name, serial and firmware, or that
 * the diagnostic server didn't see it), in place. A device the companion can't hear that the server sees is on the bus.
 */
export function joinWatched(report: Report, snapshot: Snapshot, watched: { name: string; bus: string; model: string; id: number }[]): void {
  for (const f of report.findings) {
    const w = WATCHED_DEVICE_RULES.has(f.rule) ? watched.find((d) => d.name === f.about) : undefined
    if (!w) continue
    const d = snapshotDeviceFor(snapshot, w)
    f.evidence['in the robot snapshot'] = typeof d === 'string'
      ? d
      : `${d.model} ${d.id} on the ${busLabel(d.bus)}${d.name ? ` ("${d.name}")` : ''}, serial ${d.serial || '?'}, firmware ${d.firmware || '?'}`
  }
}
