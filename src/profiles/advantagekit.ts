/**
 * Where an AdvantageKit log keeps the signals every robot has: AdvantageKit's own fixed names for the Driver Station
 * (/DriverStation), the roboRIO (/SystemStats), the build (/RealMetadata), the loop time and the console. A key that
 * is robot-specific (the gyro, the pose, the auto chooser, alert groups) is '' here: a profile fills it in.
 *
 * The AdvantageKit counterpart of datalogmanager.ts.
 */
import type { RobotProfile } from './types.ts'

export const ADVANTAGEKIT_SIGNALS: RobotProfile['signals'] = {
  enabled: '/DriverStation/Enabled',
  autonomous: '/DriverStation/Autonomous',
  fmsAttached: '/DriverStation/FMSAttached',
  dsAttached: '/DriverStation/DSAttached',
  eventName: '/DriverStation/EventName',
  matchType: '/DriverStation/MatchType',
  matchNumber: '/DriverStation/MatchNumber',
  replayNumber: '/DriverStation/ReplayNumber',
  allianceStation: '/DriverStation/AllianceStation',

  gitSha: '/RealMetadata/GitSHA',
  gitBranch: '/RealMetadata/GitBranch',
  gitDate: '/RealMetadata/GitDate',
  gitDirty: '/RealMetadata/GitDirty',

  epochMicros: '/SystemStats/EpochTimeMicros',
  systemTimeValid: '/SystemStats/SystemTimeValid',
  batteryVoltage: '/SystemStats/BatteryVoltage',
  brownedOut: '/SystemStats/BrownedOut',
  brownoutVoltage: '/SystemStats/BrownoutVoltage',
  commsDisableCount: '/SystemStats/CommsDisableCount',
  systemActive: '/SystemStats/SystemActive',

  loopCycleMs: '/RealOutputs/LoggedRobot/FullCycleMS',
  console: '/RealOutputs/Console',
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
}
