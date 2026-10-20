/**
 * Motors from a log: what a team's log already says about its motors, with no profile.
 *
 *  - Every `struct:TalonFX` entry is one motor (the struct carries its currents, velocity and temperature).
 *  - Otherwise a key ending in a current (`SupplyCurrentAmps`, `StatorCurrentAmp`, `CurrentA`, a bare `Current`) is a
 *    motor's current when the same folder also has that motor's velocity, voltage, temperature or connected flag.
 *    The motor is the key without the current part, so `/X/DriveSupplyCurrentAmps` and `/X/DriveStatorCurrentAmps`
 *    are one motor, `/X/Drive`. A bare `Current` leaf with no unit (`/Arm/Position/Current`) often means "the
 *    present value", so a velocity beside it isn't enough: it needs a voltage, temperature or connected key.
 *  - /SystemStats and /PowerDistribution (not motors), /RealOutputs (computed values) and dashboard tables (copies a
 *    team chose to show, rarely every motor) are skipped. Dashboard currents are listed as seen, not used.
 */
import { structLayout, type WpilogEntry, type WpilogFile } from '../readers/wpilog.ts'

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
}

export interface LogMotors {
  motors: LogMotor[]
  /** Current keys seen but not read as motors, and why. */
  notUsed: { key: string; why: string }[]
  /** What the log has that v1 can't read, in words. */
  limits: string[]
}

const CURRENT = /(Supply|Stator)?Current(Amps?|A)?$/
const SKIP = /^(NT:)?\/(SystemStats|PowerDistribution|RealOutputs|\.schema)(\/|$)/
const DASHBOARD = /^(NT:)?\/(SmartDashboard|Shuffleboard|Elastic|NetworkInputs\/SmartDashboard|DashboardInputs)(\/|$)/
const NUMERIC = new Set(['double', 'float', 'int64'])
/** A sibling that says this is a motor (not, say, a computed "current" of something else). */
const MOTOR_SIBLING = /Velocity|Volt|Temp|Connected/
/** What a bare, unitless `Current` needs beside it: a mechanism's position or setpoint folder has a velocity too. */
const DEVICE_SIBLING = /Volt|Temp|Connected/
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
  const stems = new Map<string, { folder: string; part: string; keys: { kind: 'supply' | 'stator' | 'current'; name: string }[] }>()
  const arrays = new Map<string, number>()
  for (const e of entries) {
    const i = e.name.lastIndexOf('/')
    const leaf = e.name.slice(i + 1)
    const m = CURRENT.exec(leaf)
    if (!m || SKIP.test(e.name)) continue
    if (DASHBOARD.test(e.name)) { if (NUMERIC.has(e.type)) notUsed.push({ key: e.name, why: 'a dashboard copy' }); continue }
    if (e.type === 'double[]' || e.type === 'float[]') { arrays.set(e.name.slice(0, i), (arrays.get(e.name.slice(0, i)) ?? 0) + 1); continue }
    if (!NUMERIC.has(e.type)) continue
    const folder = e.name.slice(0, i)
    const part = leaf.slice(0, m.index)
    const path = part ? `${folder}/${part}` : folder
    if (!stems.has(path)) stems.set(path, { folder, part, keys: [] })
    stems.get(path)!.keys.push({ kind: m[1] === 'Supply' ? 'supply' : m[1] === 'Stator' ? 'stator' : 'current', name: e.name })
  }
  if (arrays.size) limits.push(`${[...arrays.values()].reduce((a, b) => a + b, 0)} current keys in ${arrays.size} folder${arrays.size === 1 ? '' : 's'} are arrays (one value per motor, ${[...arrays.keys()].slice(0, 2).join(', ')}${arrays.size > 2 ? ', …' : ''}); v1 doesn't read arrays as motors`)

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
    if (own.length === 0) { for (const k of s.keys) notUsed.push({ key: k.name, why: 'no velocity, voltage, temperature or connected key beside it' }); continue }
    const bare = s.part === '' && s.keys.every((k) => k.name.endsWith('/Current'))
    if (bare && !own.some((e) => DEVICE_SIBLING.test(rest(e)))) { for (const k of s.keys) notUsed.push({ key: k.name, why: 'a bare "Current" with only a velocity beside it (a present value, not amps?)' }); continue }
    const pick = (re: RegExp, types: Set<string>, avoid?: RegExp) => own.filter((e) => re.test(rest(e)) && types.has(e.type) && !(avoid && avoid.test(rest(e)))).map((e) => e.name).sort((a, b) => a.length - b.length)[0]
    const find = (kind: string) => s.keys.find((k) => k.kind === kind)?.name
    motors.push(clean({
      path, from: 'keys',
      supplyCurrent: find('supply'), statorCurrent: find('stator'), current: find('current'),
      velocity: pick(/Velocity/, NUMERIC, /Target|Setpoint|Goal|Desired|Reference|Requested|Command/),
      connected: pick(/Connected$/, new Set(['boolean'])),
      temperature: pick(/Temp/, NUMERIC),
    }))
  }
  return { motors: motors.sort((a, b) => a.path.localeCompare(b.path)), notUsed, limits }
}

function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}
