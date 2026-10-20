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
import type { WpilogFile } from '../readers/wpilog.ts'
import { DSLOG } from './sources.ts'
import type { ResolvedProfile, SignalSources } from './types.ts'

const FMS = 'NT:/FMSInfo'

/** The control word's FMS-attached and DS-attached bits, as keys (see readers/wpilog.ts: "<entry>:bit<n>"). */
export const FMS_ATTACHED = `${FMS}/FMSControlData:bit4`
export const DS_ATTACHED = `${FMS}/FMSControlData:bit5`

/**
 * For each signal a DataLogManager log can supply, where it is. A key of '' means "this kind of log doesn't have
 * it": rules that need it say so under "Not checked". A team profile starts from this and fills in what its robot
 * publishes (battery voltage, gyro, pose). AdvantageKit's map lists these identity keys after its own, so any
 * profile can tell which match a plain WPILib log holds (advantagekit.ts).
 */
export const DATALOGMANAGER_SIGNALS: SignalSources = {
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
  // Nothing in the robot log; the Driver Station log has its own flag.
  brownedOut: `${DSLOG}brownout`,
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
  // The HAL control word's e-stop bit (see the header). The match clock, the auto chooser and joystick button counts
  // have no place WPILib always logs them.
  emergencyStop: `${FMS}/FMSControlData:bit3`,
  matchTimeLeft: '',
  autoChoice: '',
  joystickButtonCounts: [],
  radioConnected: '',
  powerDistributionCurrents: '',
  powerDistributionVoltage: '',
  powerDistributionChannels: '',
  totalCurrent: '',
}

/**
 * The profile with WPILib Alerts groups found in the log added: WPILib's Alerts publish each group to NetworkTables
 * with a .type of "Alerts" (Shuffleboard/Elastic read it), so groups the profile doesn't name (PathPlanner's,
 * PhotonVision's) are read too. Returns the profile itself when there are none.
 */
export function withNtAlertGroups(log: WpilogFile, profile: ResolvedProfile): ResolvedProfile {
  const alertGroups = [...log.entries.values()]
    .filter((e) => e.name.endsWith('/.type') && /"SmartDashboard"\s*:\s*"Alerts"/.test(e.metadata))
    .map((e) => e.name.slice(0, -'/.type'.length))
    .filter((g) => !profile.signals.alertGroups.includes(g))
  if (alertGroups.length === 0) return profile
  return { ...profile, signals: { ...profile.signals, alertGroups: [...profile.signals.alertGroups, ...alertGroups] } }
}
