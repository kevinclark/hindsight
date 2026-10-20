/**
 * Where an AdvantageKit log keeps the signals every robot has: AdvantageKit's own fixed names for the Driver Station
 * (/DriverStation), the roboRIO (/SystemStats), the build (/RealMetadata), the power distribution board, the loop
 * time and the console. A key that is robot-specific (the gyro, the pose, the auto chooser, alert groups) is '' here:
 * a profile fills it in. A list is places to look in order (src/profiles/sources.ts).
 *
 * The AdvantageKit counterpart of datalogmanager.ts.
 */
import { DATALOGMANAGER_SIGNALS } from './datalogmanager.ts'
import { DSLOG, keysOf } from './sources.ts'
import type { SignalKeys, SignalSources, Source } from './types.ts'

/** AdvantageKit's key, then the plain WPILib log's: so any profile can tell which match such a log holds. */
const orPlain = (key: string, name: keyof SignalKeys) => [key, ...keysOf(DATALOGMANAGER_SIGNALS[name] as Source)]

export const ADVANTAGEKIT_SIGNALS: SignalSources = {
  enabled: orPlain('/DriverStation/Enabled', 'enabled'),
  autonomous: orPlain('/DriverStation/Autonomous', 'autonomous'),
  fmsAttached: orPlain('/DriverStation/FMSAttached', 'fmsAttached'),
  dsAttached: orPlain('/DriverStation/DSAttached', 'dsAttached'),
  eventName: orPlain('/DriverStation/EventName', 'eventName'),
  matchType: orPlain('/DriverStation/MatchType', 'matchType'),
  matchNumber: orPlain('/DriverStation/MatchNumber', 'matchNumber'),
  replayNumber: orPlain('/DriverStation/ReplayNumber', 'replayNumber'),
  allianceStation: '/DriverStation/AllianceStation',

  gitSha: '/RealMetadata/GitSHA',
  gitBranch: '/RealMetadata/GitBranch',
  gitDate: '/RealMetadata/GitDate',
  gitDirty: '/RealMetadata/GitDirty',
  // AdvantageKit's template names the code ProjectName; some teams set Codebase.
  codebase: ['/RealMetadata/Codebase', '/RealMetadata/ProjectName'],
  logClock: '/Timestamp',

  epochMicros: orPlain('/SystemStats/EpochTimeMicros', 'epochMicros'),
  systemTimeValid: '/SystemStats/SystemTimeValid',
  batteryVoltage: '/SystemStats/BatteryVoltage',
  // Without it in the robot log, the Driver Station log's own brownout flag.
  brownedOut: ['/SystemStats/BrownedOut', `${DSLOG}brownout`],
  brownoutVoltage: '/SystemStats/BrownoutVoltage',
  commsDisableCount: '/SystemStats/CommsDisableCount',
  systemActive: '/SystemStats/SystemActive',

  loopCycleMs: '/RealOutputs/LoggedRobot/FullCycleMS',
  console: orPlain('/RealOutputs/Console', 'console'),
  alertGroups: [],

  gyroPitch: '',
  gyroRoll: '',
  accelX: '',
  accelY: '',
  odometryPose: '',

  emergencyStop: '/DriverStation/EmergencyStop',
  matchTimeLeft: '/DriverStation/MatchTime',
  autoChoice: '',
  joystickButtonCounts: [0, 1, 2, 3, 4, 5].map((n) => `/DriverStation/Joystick${n}/ButtonCount`),

  radioConnected: '/RadioStatus/Connected',
  powerDistributionCurrents: '/PowerDistribution/ChannelCurrent',
  powerDistributionVoltage: '/PowerDistribution/Voltage',
  powerDistributionChannels: '/PowerDistribution/ChannelCount',
  // AdvantageKit logs the board's total too, but the power model adds up the motors: a measured total has been
  // checked only on DogLog logs (doglog.ts).
  totalCurrent: '',
}
