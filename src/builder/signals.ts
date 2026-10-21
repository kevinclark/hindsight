/**
 * The standard signals of a log with no profile: the framework's fixed names (AdvantageKit or WPILib's
 * DataLogManager), the code's identity, and the robot-specific keys that can be told by their shape alone.
 */
import { hasEntry, readValues, type WpilogEntry, type WpilogFile } from '../readers/wpilog.ts'
import { codeIdentity, firstText, formatOf, isRoboRioReading, LOG_FORMATS } from '../profiles/formats.ts'
import type { RobotProfile } from '../profiles/types.ts'

type Signals = RobotProfile['signals']
type Battery = RobotProfile['battery']

/** The log type's name (profiles/formats.ts), or 'unknown'. */
export type Framework = string

export interface SignalDraft {
  framework: Framework
  signals: Signals
  /** Keys the builder picked by shape, not by a fixed name: shown with "confirm". */
  guessed: (keyof Signals)[]
  /** Other keys that could be the same signal, for the confirm step. */
  alternatives: Partial<Record<keyof Signals, string[]>>
  battery: Battery
  codebase: string
  code: RobotProfile['code']
  otherDevices: RobotProfile['otherDevices']
}

const records = (log: WpilogFile, e: WpilogEntry) => log.entryStart[e.id + 1] - log.entryStart[e.id]
/** The code's name for itself (the log type's codebase signal). */
export const codebaseOf = (log: WpilogFile) => codeIdentity(log).codebase

/** Folders whose `errors` / `warnings` / `infos` children are string arrays: AdvantageKit's (and WPILib's) Alerts groups. */
function alertGroups(entries: WpilogEntry[]): string[] {
  const groups = new Set<string>()
  for (const e of entries) {
    const m = /^(.*)\/(errors|warnings|infos)$/.exec(e.name)
    if (m && e.type === 'string[]') groups.add(m[1])
  }
  return [...groups].sort()
}

/**
 * The battery tracker's own key names (the schema battery/identity and battery/gauge-capacity already assume), wherever
 * the code logs them. One tracker's convention: a robot without it gets empty lists, and those rules say "not checked".
 */
const BATTERY_LEAVES: Record<keyof Battery, RegExp> = {
  id: /\/Battery\/Id$/,
  idSource: /\/Battery\/IdSource$/,
  gaugeValid: /\/BatteryGauge\/Valid$/,
  effectiveCapacityAh: /\/BatteryGauge\/EffectiveCapacityAh$/,
  ratedCapacityAh: /\/BatteryGauge\/RatedCapacityAh$/,
  remainingChargePct: /\/BatteryGauge\/RemainingChargePct$/,
  numCycles: /\/BatteryGauge\/NumCycles$/,
}

/** Not motors or devices this builder reads: cameras are out of scope, and their connected flags belong to them. */
const CAMERA_FOLDER = /vision|camera|photon|limelight|apriltag/i

export function signalsFromLog(log: WpilogFile, motorKeys: Set<string>): SignalDraft {
  const format = formatOf(log)
  const framework = format?.name ?? 'unknown'
  const base = (format ?? LOG_FORMATS[0]).signals
  const entries = [...log.entries.values()].filter((e) => records(log, e) > 0)
  const guessed: (keyof Signals)[] = []
  const alternatives: SignalDraft['alternatives'] = {}
  const signals: Signals = { ...base, alertGroups: alertGroups(entries), joystickButtonCounts: [...base.joystickButtonCounts] }

  // Pick a robot-specific key by shape; several candidates → the first, the rest offered.
  const choose = (name: keyof Signals, found: WpilogEntry[]) => {
    const names = [...new Set(found.map((e) => e.name))].sort((a, b) => a.length - b.length || a.localeCompare(b))
    if (!names.length) return
    ;(signals as unknown as Record<string, string>)[name] = names[0]
    guessed.push(name)
    if (names.length > 1) alternatives[name] = names.slice(1)
  }
  // Pitch and roll: Rotation2d only (the reader gives radians; a plain double could be degrees).
  choose('gyroPitch', entries.filter((e) => e.type === 'struct:Rotation2d' && /\/Pitch$/i.test(e.name)))
  choose('gyroRoll', entries.filter((e) => e.type === 'struct:Rotation2d' && /\/Roll$/i.test(e.name)))
  choose('accelX', entries.filter((e) => e.type === 'double' && /AXMetersPerSecondSq$/.test(e.name)))
  choose('accelY', entries.filter((e) => e.type === 'double' && /AYMetersPerSecondSq$/.test(e.name)))
  const poses = entries.filter((e) => e.type === 'struct:Pose2d')
  const odometry = poses.filter((e) => /\/Odometry\/Robot$/.test(e.name))
  choose('odometryPose', odometry.length ? odometry : poses.filter((e) => /odometry|estimat|robotpose|\/pose$/i.test(e.name) && !CAMERA_FOLDER.test(e.name)))
  choose('autoChoice', entries.filter((e) => e.type === 'string' && /^(\/NetworkInputs\/SmartDashboard|\/DashboardInputs|NT:\/SmartDashboard)\/[^/]*auto[^/]*$/i.test(e.name)))

  const battery = Object.fromEntries((Object.keys(BATTERY_LEAVES) as (keyof Battery)[]).map((k) => [k, entries.filter((e) => BATTERY_LEAVES[k].test(e.name)).map((e) => e.name).sort()])) as Battery

  // Connected flags that aren't a motor's or a camera's: encoders, the gyro, sensors.
  const otherDevices = entries
    .filter((e) => e.type === 'boolean' && /Connected$/.test(e.name) && !motorKeys.has(e.name) && !CAMERA_FOLDER.test(e.name) && !isRoboRioReading(e.name))
    .map((e) => ({ name: e.name.replace(/^NT:/, '').replace(/^\//, '').replace(/\/?(Is)?Connected$/, '').replace(/\//g, ' '), connected: e.name }))
    .sort((a, b) => a.connected.localeCompare(b.connected))

  // Identity: AdvantageKit's Codebase, or ProjectName (the AdvantageKit template's name for it).
  const codebase = codebaseOf(log)
  const code = { repo: '', branch: firstText(log, signals.gitBranch), sha: firstText(log, signals.gitSha) }
  return { framework, signals, guessed, alternatives, battery, codebase, code, otherDevices }
}
