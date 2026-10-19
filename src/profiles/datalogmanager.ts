/**
 * Where a plain WPILib log keeps what AdvantageKit logs under /DriverStation, /SystemStats and /RealMetadata.
 *
 * Without AdvantageKit, a robot's log comes from WPILib's DataLogManager: it records the Driver Station state as
 * DS:enabled / DS:autonomous, and (by default) every NetworkTables value with an "NT:" prefix, which includes the
 * match identity WPILib publishes under /FMSInfo. Nothing in such a log says the battery voltage, a brownout or the
 * loop time unless the team publishes it itself, so a team's profile names those keys (or leaves them out).
 *
 * Sources: WPILib DataLogManager (logs DS and NT data, "systemTime" every 5 s once the clock is set) and
 * DriverStation's FMSInfo table (EventName, MatchType 0–3, MatchNumber, ReplayNumber, StationNumber,
 * IsRedAlliance, FMSControlData: the HAL control word, bit 0 enabled, 1 autonomous, 2 test, 3 e-stop,
 * 4 FMS attached, 5 DS attached).
 */
import { hasEntry, type WpilogFile } from '../readers/wpilog.ts'
import type { RobotProfile } from './types.ts'

type Signals = RobotProfile['signals']

const FMS = 'NT:/FMSInfo'

/** The control word's FMS-attached and DS-attached bits, as keys (see readers/wpilog.ts: "<entry>:bit<n>"). */
export const FMS_ATTACHED = `${FMS}/FMSControlData:bit4`
export const DS_ATTACHED = `${FMS}/FMSControlData:bit5`

/**
 * For each signal a DataLogManager log can supply, where it is. A key of '' means "this kind of log doesn't have
 * it": rules that need it say so under "Not checked". A team profile starts from this and fills in what its robot
 * publishes (battery voltage, gyro, pose).
 */
export const DATALOGMANAGER_SIGNALS: Signals = {
  enabled: 'DS:enabled',
  autonomous: 'DS:autonomous',
  fmsAttached: FMS_ATTACHED,
  dsAttached: DS_ATTACHED,
  eventName: `${FMS}/EventName`,
  matchType: `${FMS}/MatchType`,
  matchNumber: `${FMS}/MatchNumber`,
  replayNumber: `${FMS}/ReplayNumber`,
  allianceStation: '',
  gitSha: '',
  gitBranch: '',
  gitDate: '',
  gitDirty: '',
  epochMicros: 'systemTime',
  systemTimeValid: '',
  batteryVoltage: '',
  brownedOut: '',
  brownoutVoltage: '',
  commsDisableCount: '',
  systemActive: '',
  loopCycleMs: '',
  console: 'console',
  alertGroups: [],
  gyroPitch: '',
  gyroRoll: '',
  accelX: '',
  accelY: '',
  odometryPose: '',
}

/** The signals that say which match a log holds and when the robot was enabled: always worth finding. */
const IDENTITY: (keyof Signals)[] = [
  'enabled', 'autonomous', 'fmsAttached', 'dsAttached', 'eventName', 'matchType', 'matchNumber', 'replayNumber', 'epochMicros', 'console',
]

/**
 * The profile with its match-identity keys pointed at DataLogManager's entries wherever the profile's own key isn't
 * in this log, and WPILib Alerts groups found in the log added. So any profile, even one for another robot, can tell
 * which match a plain WPILib log holds. Returns the profile itself when nothing needed filling.
 */
export function withDataLogManagerKeys(log: WpilogFile, profile: RobotProfile): RobotProfile {
  const filled: Partial<Signals> = {}
  for (const name of IDENTITY) {
    const own = profile.signals[name] as string
    const fallback = DATALOGMANAGER_SIGNALS[name] as string
    if (fallback && own !== fallback && !hasEntry(log, own) && hasEntry(log, fallback)) (filled as Record<string, string>)[name] = fallback
  }
  // WPILib's Alerts publish each group to NetworkTables with a .type of "Alerts" (Shuffleboard/Elastic read it).
  // Only when none of the profile's own alert groups is in the log, so one alert is never read from two places.
  const ownAlerts = profile.signals.alertGroups.some((g) => ['errors', 'warnings', 'infos'].some((k) => hasEntry(log, `${g}/${k}`)))
  const alertGroups = ownAlerts ? [] : [...log.entries.values()]
    .filter((e) => e.name.endsWith('/.type') && /"SmartDashboard"\s*:\s*"Alerts"/.test(e.metadata))
    .map((e) => e.name.slice(0, -'/.type'.length))
    .filter((g) => !profile.signals.alertGroups.includes(g))
  if (Object.keys(filled).length === 0 && alertGroups.length === 0) return profile
  return { ...profile, signals: { ...profile.signals, ...filled, alertGroups: [...profile.signals.alertGroups, ...alertGroups] } }
}
