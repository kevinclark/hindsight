/**
 * Motors from a log: what a team's log already says about its motors, with no profile.
 *
 *  - Every `struct:TalonFX` entry is one motor (the struct carries its currents, velocity and temperature).
 *  - Otherwise a key ending in a current (`SupplyCurrentAmps`, `StatorCurrentAmp`, `CurrentA`, a bare `Current`, or
 *    `Amps` alone: `/Shooter/PivotAmps`) is a motor's current when the same folder also has that motor's velocity or
 *    speed, voltage or percent output, temperature or connected flag. The motor is the key without the current part,
 *    so `/X/DriveSupplyCurrentAmps` and `/X/DriveStatorCurrentAmps` are one motor, `/X/Drive`.
 *  - A current that is an array (`double[]`) is one motor per element, as many as its longest record has: AdvantageKit
 *    IO classes log every motor of a mechanism in one array. One element is the motor itself (`/X/DriveCurrentAmps[0]`);
 *    two or more are numbered motors of one mechanism (`/Elevator[0]`, `/Elevator[1]`).
 *  - /SystemStats and /PowerDistribution (not motors), /RealOutputs (computed values) and dashboard tables (copies a
 *    team chose to show, rarely every motor) are skipped. Dashboard currents are listed as seen, not used.
 */
import { isRoboRioReading } from '../profiles/formats.ts'
import { readValues, structLayout, type WpilogEntry, type WpilogFile } from '../readers/wpilog.ts'

export interface LogMotor {
  /** The motor's place in the log: the struct entry (no trailing "/") or the keys' common stem. */
  path: string
  supplyCurrent?: string
  statorCurrent?: string
  /** A current key that doesn't say supply or stator: the student says which. */
  current?: string
  velocity?: string
  connected?: string
  temperature?: string
  /** How it was found. */
  from: 'struct:TalonFX' | 'keys'
  /** One element of an array current that holds two or more motors: the array's motor path, this element, how many. */
  element?: { of: string; index: number; count: number }
}

export interface LogMotors {
  motors: LogMotor[]
  /** Current keys seen but not read as motors, and why. */
  notUsed: { key: string; why: string }[]
  /** What the log has that v1 can't read, in words. */
  limits: string[]
}

const CURRENT = /(Supply|Stator)?(Current(Amps?|A)?|Amps)$/
const SKIP = /^(NT:)?\/(RealOutputs|\.schema)(\/|$)/
const DASHBOARD = /^(NT:)?\/(SmartDashboard|Shuffleboard|Elastic|NetworkInputs\/SmartDashboard|DashboardInputs)(\/|$)/
const NUMERIC = new Set(['double', 'float', 'int64'])
const ARRAYS = new Set(['double[]', 'float[]', 'int64[]'])
/** A sibling that says this is a motor (not, say, a computed "current" of something else). */
const MOTOR_SIBLING = /Velocity|Speed|Volt|PercentOut|Temp|Connected/
/** A connected flag of another device that sits beside the motor (an encoder in the same module). */
const OTHER_DEVICE = /Encoder|Cancoder|CANcoder|Gyro|Pigeon|Camera/i

const records = (log: WpilogFile, e: WpilogEntry) => log.entryStart[e.id + 1] - log.entryStart[e.id]

export function motorsFromLog(log: WpilogFile): LogMotors {
  const entries = [...log.entries.values()].filter((e) => records(log, e) > 0)
  const motors: LogMotor[] = []
  const notUsed: LogMotors['notUsed'] = []
  const limits: string[] = []

  // 1. TalonFX status structs.
  const talon = structLayout(log, 'TalonFX')
  const has = (f: string) => !!talon?.fields.some((x) => x.name === f && !x.struct && x.arrayLength === undefined)
  for (const e of entries) {
    if (e.type === 'struct:TalonFX[]') limits.push(`${e.name} logs several Talon FX as one array; v1 doesn't read arrays as motors`)
    if (e.type !== 'struct:TalonFX' || !talon) continue
    const base = e.name.endsWith('/') ? e.name : `${e.name}/`
    const key = (f: string) => (has(f) ? `${base}${f}` : undefined)
    motors.push(clean({
      path: base.slice(0, -1), from: 'struct:TalonFX',
      supplyCurrent: key('supplyCurrent'), statorCurrent: key('statorCurrent'), velocity: key('velocity'), temperature: key('deviceTemp'),
    }))
  }

  // 2. Current keys with a motor sibling.
  const byFolder = new Map<string, WpilogEntry[]>()
  for (const e of entries) {
    const i = e.name.lastIndexOf('/')
    const folder = e.name.slice(0, i)
    if (!byFolder.has(folder)) byFolder.set(folder, [])
    byFolder.get(folder)!.push(e)
  }
  type Stem = { folder: string; part: string; keys: { kind: 'supply' | 'stator' | 'current'; name: string }[]; element?: { index: number; count: number } }
  const stems = new Map<string, Stem>()
  const stem = (path: string, s: Omit<Stem, 'keys'>) => {
    if (!stems.has(path)) stems.set(path, { ...s, keys: [] })
    return stems.get(path)!
  }
  // Arrays: one length per entry (each read decodes every record).
  const lengths = new Map<string, number>()
  const longest = (key: string) => {
    if (!lengths.has(key)) lengths.set(key, longestArray(log, key))
    return lengths.get(key)!
  }
  for (const e of entries) {
    const i = e.name.lastIndexOf('/')
    const leaf = e.name.slice(i + 1)
    const m = CURRENT.exec(leaf)
    if (!m || SKIP.test(e.name) || isRoboRioReading(e.name)) continue
    if (DASHBOARD.test(e.name)) { if (NUMERIC.has(e.type)) notUsed.push({ key: e.name, why: 'a dashboard copy' }); continue }
    if (!NUMERIC.has(e.type) && !ARRAYS.has(e.type)) continue
    const folder = e.name.slice(0, i)
    const part = leaf.slice(0, m.index)
    const path = part ? `${folder}/${part}` : folder
    const kind = m[1] === 'Supply' ? 'supply' : m[1] === 'Stator' ? 'stator' : 'current'
    if (NUMERIC.has(e.type)) { stem(path, { folder, part }).keys.push({ kind, name: e.name }); continue }
    // No log in hand has an empty current array, a float[] or int64[] current, or a scalar and an array current for one
    // motor (which would draft it once more than its elements): no data covers those cases yet.
    const count = longest(e.name)
    if (count === 0) { notUsed.push({ key: e.name, why: 'an array that is always empty' }); continue }
    if (count === 1) { stem(path, { folder, part }).keys.push({ kind, name: `${e.name}[0]` }); continue }
    for (let k = 0; k < count; k++) stem(`${path}[${k}]`, { folder, part, element: { index: k, count } }).keys.push({ kind, name: `${e.name}[${k}]` })
  }

  for (const [path, s] of stems) {
    // The siblings that belong to this motor: same folder, leaf starting with its name part, and not with a longer
    // name part of another motor in the folder (`Kicker` must not take `KickerLeaderConnected`).
    const longer = [...stems.values()].filter((o) => o.folder === s.folder && o.part.length > s.part.length && o.part.startsWith(s.part)).map((o) => o.part)
    const siblings = (byFolder.get(s.folder) ?? []).filter((e) => {
      const leaf = e.name.slice(s.folder.length + 1)
      return leaf.startsWith(s.part) && !longer.some((p) => leaf.startsWith(p)) && !CURRENT.test(leaf)
    })
    const rest = (e: WpilogEntry) => e.name.slice(s.folder.length + 1 + s.part.length)
    const own = siblings.filter((e) => MOTOR_SIBLING.test(rest(e)) && !OTHER_DEVICE.test(rest(e)))
    if (own.length === 0) { for (const k of s.keys) notUsed.push({ key: k.name, why: 'no velocity, speed, voltage, percent output, temperature or connected key beside it' }); continue }
    // A sibling of a motor of its own is the key itself, or its first element when it is an array of one; a numbered
    // motor of an array takes only the same element of an array sibling (a plain sibling is the whole mechanism's).
    const index = s.element?.index ?? 0
    const keyOf = (e: WpilogEntry) => (e.type.endsWith('[]') ? `${e.name}[${index}]` : e.name)
    const fits = (e: WpilogEntry, types: Set<string>) => {
      if (types.has(e.type)) return !s.element
      return e.type.endsWith('[]') && types.has(e.type.slice(0, -2)) && longest(e.name) === (s.element?.count ?? 1)
    }
    const pick = (re: RegExp, types: Set<string>, avoid?: RegExp) => own.filter((e) => re.test(rest(e)) && fits(e, types) && !(avoid && avoid.test(rest(e)))).map(keyOf).sort((a, b) => a.length - b.length)[0]
    const find = (kind: string) => s.keys.find((k) => k.kind === kind)?.name
    motors.push(clean({
      path, from: 'keys',
      supplyCurrent: find('supply'), statorCurrent: find('stator'), current: find('current'),
      velocity: pick(/Velocity|Speed/, NUMERIC, /Target|Setpoint|Goal|Desired|Reference|Requested|Command/),
      connected: pick(/Connected$/, new Set(['boolean'])),
      temperature: pick(/Temp/, NUMERIC),
      element: s.element && { of: path.slice(0, path.lastIndexOf('[')), ...s.element },
    }))
  }
  return { motors: motors.sort((a, b) => a.path.localeCompare(b.path)), notUsed, limits }
}

/** The most elements any record of an array entry has. */
function longestArray(log: WpilogFile, key: string): number {
  return (readValues<unknown[]>(log, key)?.v ?? []).reduce((n, a) => Math.max(n, a.length), 0)
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
