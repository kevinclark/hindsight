/**
 * Reading a robot snapshot: the snapshot.json that tools/robot-snapshot.py writes from the Phoenix diagnostic server.
 * The collector stores the server's answers as they came; everything here interprets them.
 *
 * Response shapes so far come from CTRE's 26.3.0 simulator, not a real robot (the file's `responseShapes` says
 * which). Parsing is lenient where a real robot may differ (how booleans are spelled) and says so rather than guess.
 */

export const SNAPSHOT_SCHEMA = 'hindsight.robot-snapshot/1'

export interface Config {
  group: string
  signalName: string
  name: string
  type: string
  value: unknown
  defaultValue: unknown
  units: string
}

export interface Signal { id: number; name: string; units: string }

export interface Device {
  /** "<CANbus>|<Model>|<ID>", as the collector keys its answers. */
  key: string
  model: string
  id: number
  /** The CANbus string from the server: "" is the roboRIO's own bus. */
  bus: string
  name: string
  firmware: string
  serial: string
  pro: boolean
  /** A motor controller (Talon FX or Talon FXS). */
  isMotor: boolean
  /** How many devices answered to this model + ID on this bus (2+ is a duplicate ID). */
  count: number
  serials: string[]
  signals: Signal[] | null
  configs: Config[] | null
  selfTest: Record<string, { Units?: string; Value?: unknown }> | null
  /** Why the collector didn't read this device, if it didn't. */
  skipped: string | null
}

export interface HootFile {
  name: string
  remote?: string
  compliancy?: number | null
  owlet?: string | null
  pro: boolean | null
  signals: string[]
  wpilog: string | null
  note?: string
}

export interface Snapshot {
  fileName: string
  takenAt: string
  takenAtLocal: string
  address: string | null
  collectorVersion: string
  responseShapes: string
  provenance: string
  serverVersion: string | null
  /** Access-Control-Allow-Origin on the getversion answer (asked with Origin: null), or null when absent. */
  allowOrigin: string | null
  /** Whether the getversion answer (and so its headers) was read at all. */
  versionRead: boolean
  busUtilPerc: number | null
  stopped: { action: string; device: string | null; reason: string } | null
  route: { interface: string | null; note: string } | null
  devices: Device[]
  hoot: { listed: number; files: HootFile[]; notes: string[] } | null
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const str = (x: unknown) => (typeof x === 'string' ? x : x === undefined || x === null ? '' : String(x))

export const busLabel = (bus: string) => (bus === '' ? 'roboRIO bus' : bus)
export const isMotorModel = (model: string) => /^Talon FX/i.test(model)

/** "true" / "1" / "yes" / "on" (any case), 1, true → true; the opposites → false; anything else → null (unreadable). */
export function parseBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', '1.0'].includes(v)) return true
    if (['false', '0', 'no', 'off', '0.0'].includes(v)) return false
  }
  return null
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

function readConfigs(body: unknown): Config[] | null {
  if (!isObject(body) || !Array.isArray(body.Device)) return null
  const out: Config[] = []
  for (const group of body.Device) {
    if (!isObject(group) || !Array.isArray(group.Configs)) continue
    for (const c of group.Configs) {
      if (!isObject(c)) continue
      out.push({ group: str(group.Name), signalName: str(c.SignalName), name: str(c.Name), type: str(c.Type), value: c.Value, defaultValue: c.DefaultValue, units: str(c.Units) })
    }
  }
  return out
}

function readSignals(body: unknown): Signal[] | null {
  if (!isObject(body) || !Array.isArray(body.Signals)) return null
  return body.Signals.filter(isObject).map((s) => ({ id: Number(s.Id), name: str(s.Name), units: str(s.Units) }))
}

function readHoot(hoot: unknown): Snapshot['hoot'] {
  if (!isObject(hoot)) return null
  const files = (Array.isArray(hoot.files) ? hoot.files : []).filter(isObject).map((f): HootFile => {
    const scan = isObject(f.scan) ? str(f.scan.stdout) : ''
    const checkPro = isObject(f.checkPro) ? str(f.checkPro.stdout) : ''
    return {
      name: str(f.name) || str(f.remote).split('/').pop() || '',
      remote: f.remote === undefined ? undefined : str(f.remote),
      compliancy: typeof f.compliancy === 'number' ? f.compliancy : null,
      owlet: f.owlet === undefined || f.owlet === null ? null : str(f.owlet),
      pro: /NOT Pro-licensed/i.test(checkPro) ? false : /Pro-licensed/i.test(checkPro) ? true : null,
      // `--scan` prints "Name: id" per signal
      signals: scan.split('\n').filter((l) => l.includes(':')).map((l) => l.split(':')[0].trim()).filter((n, i, all) => n && /^\S+$/.test(n) && all.indexOf(n) === i),
      wpilog: f.wpilog ? str(f.wpilog) : null,
      note: f.note === undefined ? undefined : str(f.note),
    }
  })
  return { listed: Array.isArray(hoot.listed) ? hoot.listed.length : 0, files, notes: (Array.isArray(hoot.notes) ? hoot.notes : []).map(str) }
}

/** Parse a snapshot.json. Throws an Error naming what's wrong when it isn't one. */
export function parseSnapshot(text: string, fileName = 'snapshot.json'): Snapshot {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error(`${fileName} is not JSON`) }
  if (!isObject(raw)) throw new Error(`${fileName} is not a robot snapshot`)
  if (raw.schema !== SNAPSHOT_SCHEMA) throw new Error(`${fileName} is not a robot snapshot (schema ${JSON.stringify(raw.schema ?? null)}, expected ${SNAPSHOT_SCHEMA})`)
  if (typeof raw.takenAt !== 'string') throw new Error(`${fileName}: no takenAt`)
  if (!isObject(raw.devices)) throw new Error(`${fileName}: no devices`)

  const version = isObject(raw.getversion) ? raw.getversion : null
  const headers = version && Array.isArray(version.headers) ? (version.headers as unknown[]).filter(Array.isArray) as unknown[][] : []
  const allow = headers.find((h) => str(h[0]).toLowerCase() === 'access-control-allow-origin')
  const deviceBody = isObject(raw.getdevices) && isObject(raw.getdevices.body) ? raw.getdevices.body : null
  const array = deviceBody && Array.isArray(deviceBody.DeviceArray) ? deviceBody.DeviceArray.filter(isObject) : []
  const skipped = new Map((Array.isArray(raw.skipped) ? raw.skipped.filter(isObject) : []).map((s) => [str(s.device), str(s.reason)]))
  const answers = raw.devices as Record<string, unknown>

  const byKey = new Map<string, Device>()
  for (const d of array) {
    const key = `${str(d.CANbus)}|${str(d.Model)}|${str(d.ID)}`
    const existing = byKey.get(key)
    if (existing) {
      existing.count++
      existing.serials.push(str(d.SerialNo))
      continue
    }
    const answer = isObject(answers[key]) ? answers[key] : {}
    const selfTest = isObject(answer.decoratedselftest) && isObject(answer.decoratedselftest.SelfTest) ? answer.decoratedselftest.SelfTest as Device['selfTest'] : null
    byKey.set(key, {
      key, model: str(d.Model), id: Number(d.ID), bus: str(d.CANbus), name: str(d.Name), firmware: str(d.CurrentVers), serial: str(d.SerialNo),
      pro: d.IsPROLicensed === true || d.IsPROApplication === true, isMotor: isMotorModel(str(d.Model)), count: 1, serials: [str(d.SerialNo)],
      signals: readSignals(answer.getsignals), configs: readConfigs(answer.getconfigv2), selfTest, skipped: skipped.get(key) ?? null,
    })
  }

  const collector = isObject(raw.collector) ? raw.collector : {}
  const stopped = isObject(raw.stopped) ? { action: str(raw.stopped.action), device: raw.stopped.device ? str(raw.stopped.device) : null, reason: str(raw.stopped.reason) } : null
  return {
    fileName,
    takenAt: raw.takenAt,
    takenAtLocal: str(raw.takenAtLocal) || raw.takenAt,
    address: raw.address ? str(raw.address) : null,
    collectorVersion: str(collector.version),
    responseShapes: str(raw.responseShapes) || 'simulator',
    provenance: str(raw.provenance),
    serverVersion: version && isObject(version.body) ? str(version.body.Version) || null : null,
    allowOrigin: allow ? str(allow[1]) : null,
    versionRead: version !== null,
    busUtilPerc: deviceBody && typeof deviceBody.BusUtilPerc === 'number' ? deviceBody.BusUtilPerc : null,
    stopped,
    route: isObject(raw.route) ? { interface: raw.route.interface ? str(raw.route.interface) : null, note: str(raw.route.note) } : null,
    devices: [...byKey.values()],
    hoot: readHoot(raw.hoot),
  }
}

/** A config's value by signal name (never by id: ids change between Phoenix versions). */
export function configOf(device: Device, signalName: string): Config | undefined {
  return device.configs?.find((c) => c.signalName === signalName)
}
