/**
 * The Hindsight companion library's device and hoot keys (companion/keys.json, companion/README.md), and how to read
 * them. A robot that doesn't use the companion has none of these keys; everything here then answers "none" or null,
 * and the checks that need them say "not checked".
 *
 * HindsightDevices.watch(device) logs each watched CTRE device once a second under
 * /Hindsight/Devices/<bus>/<model>/<id>/: <bus> is the CAN bus name (CANBus("*") logs as Any, the roboRIO's as rio),
 * <model> the Java class (TalonFX, CANcoder, Pigeon2, ...). Nothing here has been read from a real robot yet.
 */
import { hasEntry, type WpilogFile } from '../readers/wpilog.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { heldAt, valueAt, type Interval, type NumberSeries } from './series.ts'
import { num, values, type Match } from './match.ts'

/** Every key the companion logs starts with this. */
export const COMPANION_ROOT = '/Hindsight/'
export const DEVICES_ROOT = '/Hindsight/Devices/'

/** The companion reads each device once a second. */
export const DEVICE_READ_SECONDS = 1
/**
 * How late "not answering" can show after a device stops: up to one read (1 s), plus Phoenix's own 0.5 s before a
 * signal counts as old (DeviceIOReal.MAX_AGE_SECONDS). From the companion's code, not measured on a robot.
 */
export const DEVICE_LATE_SECONDS = DEVICE_READ_SECONDS + 0.5

/** Each device's keys, after /Hindsight/Devices/<bus>/<model>/<id>/. */
export const DEVICE_FIELDS = ['Connected', 'Version', 'FaultField', 'StickyFaultField', 'ProLicensed', 'Resets', 'Status'] as const
export type DeviceField = (typeof DEVICE_FIELDS)[number]

export const HOOT_KEYS = {
  recording: '/Hindsight/Hoot/Recording',
  filesWriting: '/Hindsight/Hoot/FilesWriting',
  newestFile: '/Hindsight/Hoot/NewestFile',
  newestSizeBytes: '/Hindsight/Hoot/NewestSizeBytes',
  secondsSinceWritten: '/Hindsight/Hoot/SecondsSinceWritten',
  status: '/Hindsight/Hoot/Status',
} as const

/** One device the robot code gave to HindsightDevices.watch, as the log names it. */
export interface WatchedEntry {
  bus: string
  model: string
  id: number
  /** "/Hindsight/Devices/<bus>/<model>/<id>": add "/Connected", "/Resets", ... */
  prefix: string
}

const DEVICE_KEY = /^\/Hindsight\/Devices\/([^/]+)\/([^/]+)\/(\d+)\/Connected$/

/** Every watched device in the log (one with a Connected record), in key order. */
export function watchedIn(log: WpilogFile): WatchedEntry[] {
  const found: WatchedEntry[] = []
  for (const name of [...log.entries.keys()].sort()) {
    const m = DEVICE_KEY.exec(name)
    if (!m || !hasEntry(log, name)) continue
    found.push({ bus: m[1], model: m[2], id: Number(m[3]), prefix: name.slice(0, -'/Connected'.length) })
  }
  return found
}

/** True when the log has any key the companion logs: the robot runs it, watched devices or not. */
export function companionIn(log: WpilogFile): boolean {
  for (const name of log.entries.keys()) if (name.startsWith(COMPANION_ROOT) && hasEntry(log, name)) return true
  return false
}

/** The companion's models that are motor controllers (the profile's motors are these). */
export const MOTOR_MODELS = ['TalonFX', 'TalonFXS']

/** The profile's model names for the other CTRE devices it lists (foresight.snapshot.devices), as the companion logs them. */
const PROFILE_MODELS: Record<string, string> = { CANcoder: 'CANcoder', 'Pigeon 2': 'Pigeon2' }

/** A device the robot profile names, by model and CAN ID: its name, the Connected flag the profile reads, and its Device key. */
export interface ProfileDevice {
  name: string
  models: string[]
  id: number
  connected?: string
  /** Where the motor's IO logs the key HindsightDevices.watch returned ("Any/TalonFX/15"), if it does (motors only). */
  deviceKey?: string
}

/**
 * Every CTRE device the profile names with a CAN ID: each motor (a Talon FX or FXS), then the CANcoders and gyro of
 * foresight.snapshot. The profile names no bus, so without a Device key a device is known by model and ID only.
 */
export function profileDevices(profile: RobotProfile): ProfileDevice[] {
  const motors = profile.motorGroups.flatMap((g) => g.motors).flatMap((m) =>
    m.canId === undefined ? [] : [{ name: m.name, models: MOTOR_MODELS, id: m.canId, connected: m.connected, deviceKey: motorDeviceKey(m) }])
  const others = (profile.foresight?.snapshot?.devices ?? []).map((d) => ({
    name: d.name, models: [PROFILE_MODELS[d.model]], id: d.canId,
    connected: profile.otherDevices.find((o) => o.name === d.name)?.connected,
  }))
  return [...motors, ...others]
}

/** The end of a current key (as the builder reads them, builder/motors.ts), or of a Connected flag. */
const MOTOR_FIELD = /((Supply|Stator)?Current(Amps?|A)?|Connected)$/

/**
 * Where a motor's IO logs its Device key: beside its other keys, named like them. /Drum/Hood/SupplyCurrentAmps gives
 * /Drum/Hood/Device; /Swerve/Front Left Module/DriveConnected gives /Swerve/Front Left Module/DriveDevice.
 */
export function motorDeviceKey(m: { supplyCurrent?: string; statorCurrent?: string; connected?: string }): string | undefined {
  const key = [m.supplyCurrent, m.statorCurrent, m.connected].find((k) => k && MOTOR_FIELD.test(k))
  return key ? key.replace(MOTOR_FIELD, 'Device') : undefined
}

/** The CAN ID in a Device key's value ("Any/TalonFX/15" → 15), or undefined. */
export function idFromDeviceKey(value: string): number | undefined {
  const id = value.split('/').pop() ?? ''
  return /^\d+$/.test(id) ? Number(id) : undefined
}

/** A watched device's own key, as HindsightDevices.watch returns it: "Any/TalonFX/15". */
export const deviceKeyOf = (w: WatchedEntry) => w.prefix.slice(DEVICES_ROOT.length)

/**
 * Which profile device each watched device is (by its prefix). Exact first: a motor whose IO logs a Device key naming
 * it. Then, for a profile device with no Device key in the log, the one watched device of its model and CAN ID; two
 * watched devices of one model and ID (on two buses) can't be told apart, so neither gets the profile's name.
 */
export function twinsOf(match: Match, devices: ProfileDevice[], watched: WatchedEntry[]): Map<string, ProfileDevice> {
  const twins = new Map<string, ProfileDevice>()
  const logged = new Map(devices.flatMap((d) => {
    const v = d.deviceKey ? values<string>(match, d.deviceKey) : null
    return v && v.v.length ? [[d, String(v.v[v.v.length - 1])] as const] : []
  }))
  for (const w of watched) {
    const exact = devices.find((d) => logged.get(d) === deviceKeyOf(w))
    if (exact) twins.set(w.prefix, exact)
  }
  for (const d of devices.filter((x) => !logged.has(x))) {
    const same = watched.filter((w) => !twins.has(w.prefix) && w.id === d.id && d.models.includes(w.model))
    if (same.length === 1) twins.set(same[0].prefix, d)
  }
  return twins
}

/** "TalonFX 15 on Any": a watched device's name when the profile doesn't name it. */
export const watchedName = (w: { bus: string; model: string; id: number }) => `${w.model} ${w.id} on ${w.bus}`

/**
 * A firmware version as Phoenix packs it (major, minor, bugfix, build: one byte each, major first), e.g. 26.1.0.2.
 * The layout is the companion's reading of Phoenix's docs (DeviceIO.java); no real device has been read yet.
 */
export function versionText(packed: number): string {
  const v = packed >>> 0
  return [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join('.')
}

/** A 32-bit field as hex, e.g. 0x00000104 (fault fields: Phoenix calls the bits device-specific and publishes no layout). */
export const hex32 = (field: number) => `0x${(field >>> 0).toString(16).toUpperCase().padStart(8, '0')}`

/** Whether Phoenix's hoot recording was on, from the companion's /Hindsight/Hoot keys, for one stretch of the log. */
export interface HootLine {
  /** 'whole': on at every reading in the stretch; 'part': on for some of it; 'off': never on; 'unknown': not readable. */
  state: 'whole' | 'part' | 'off' | 'unknown'
  /** The sentence the page shows. */
  text: string
}

/**
 * Was hoot recording during this stretch (the match, or a Foresight check's stretch)? Null when the robot doesn't log
 * the companion's hoot keys. "Recording" is the companion's guess: a .hoot file written in the last 5 s
 * (HootIOReal.RECORDING_WITHIN_SECONDS, not checked on a robot).
 */
export function hootLine(match: Match, stretch: Interval, words: string): HootLine | null {
  const recording = num(match, HOOT_KEYS.recording)
  if (!recording || recording.v.length === 0) return null
  const status = values<string>(match, HOOT_KEYS.status)
  const statusAt = (t: number) => (status ? heldAt(status, t) ?? '' : '')
  const unread = statusAt(stretch.end)
  if (unread && unread !== 'ok' && unread !== 'no hoot files') {
    return { state: 'unknown', text: `Phoenix hoot recording ${words}: not known (the companion couldn't look: ${unread})` }
  }
  const on = secondsOn(recording, stretch)
  const seconds = stretch.end - stretch.start
  const newestFiles = values<string>(match, HOOT_KEYS.newestFile)
  const sizes = num(match, HOOT_KEYS.newestSizeBytes)
  const newest = newestFiles ? heldAt(newestFiles, stretch.end) ?? '' : ''
  const size = sizes ? valueAt(sizes, stretch.end) : NaN
  const file = newest ? ` Newest file: ${newest.split('/').pop()}${Number.isFinite(size) ? ` (${megabytes(size)})` : ''}.` : ''
  const how = ' (from the Hindsight companion: a .hoot file written in the last 5 s counts as recording)'
  if (on >= seconds - DEVICE_READ_SECONDS) return { state: 'whole', text: `Phoenix hoot was recording ${words}${how}.${file}` }
  if (on > 0) return { state: 'part', text: `Phoenix hoot was recording for ${Math.round(on)} of the ${Math.round(seconds)} s ${words}${how}.${file}` }
  return { state: 'off', text: `Phoenix hoot was not recording ${words}${how}: no hoot log of it.${file}` }
}

/** How long a true/false signal was true inside the stretch (s), holding each value until the next record. */
function secondsOn(s: NumberSeries, stretch: Interval): number {
  let total = 0
  for (let i = 0; i < s.t.length; i++) {
    if (s.v[i] < 0.5) continue
    const end = i + 1 < s.t.length ? s.t[i + 1] : Infinity
    total += Math.max(0, Math.min(end, stretch.end) - Math.max(s.t[i], stretch.start))
  }
  return total
}

const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`
