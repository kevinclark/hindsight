/**
 * Robot profile for team 8033's 2025 offseason robot (HighlanderRobotics/2025-Offseason-Robot), the REEFSCAPE robot.
 *
 * Rules never hard-code a log key. They ask this file, so a new robot or a renamed subsystem means editing
 * this file, not the rules. Copy it for next season's robot.
 *
 * Current limits are copied from the robot code on branch `event-mttd`, commit 493666f (2025-11-09), the last
 * commit the robot ran at its Nov 8-9 2025 event. The branch was deleted afterwards; the commit is still in
 * main's history. A limit the code never sets is left out; Phoenix 6 v25 defaults then apply (70 A supply,
 * 120 A stator, both on; the supply cap drops to 40 A after 1.0 s at the limit).
 *
 * What this robot does not log, so the profile leaves it out or names a key that no log has:
 *   - no `Connected` flag for any TalonFX, CANcoder, CANrange or camera (only the Pigeon: /Swerve/Gyro/IsConnected);
 *   - no battery tracker (the battery arrays are the 2026 ones and will not be found);
 *   - no gyro acceleration (the keys below are the AdvantageKit-style guess, copied from the 2026 profile).
 */

import type { RobotProfile } from './types.ts'

const swerveModules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']
// OffseasonBotSwerveConstants.java:33-48: [drive CAN ID, steer CAN ID, CANcoder ID] per module.
const swerveIds: Record<string, [number, number, number]> = {
  'Front Left': [0, 1, 0],
  'Front Right': [2, 3, 1],
  'Back Left': [4, 5, 2],
  'Back Right': [6, 7, 3],
}

export const offseason2025: RobotProfile = {
  name: '2025 offseason robot',
  codebase: '2025 Offseason',
  code: { repo: 'HighlanderRobotics/2025-Offseason-Robot', branch: 'event-mttd', sha: '493666f' },

  // Field size from the robot code's tag layout (src/main/deploy/vision/2025-reefscape.json at 493666f).
  game: { name: '2025 REEFSCAPE', autoSeconds: 15, teleopSeconds: 135, field: { length: 17.548, width: 8.052 } },

  signals: {
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
    alertGroups: ['/RealOutputs/Alerts', '/RealOutputs/PhotonAlerts', '/RealOutputs/Choreo Alerts'],

    // GyroIO logs Pitch, Roll, Yaw (all Rotation2d), YawVelocityRadPerSec and IsConnected, and no acceleration.
    // The two accel keys are the likely AdvantageKit names (as in the 2026 profile); no 2025 log has them.
    gyroPitch: '/Swerve/Gyro/Pitch',
    gyroRoll: '/Swerve/Gyro/Roll',
    accelX: '/Swerve/Gyro/AXMetersPerSecondSq',
    accelY: '/Swerve/Gyro/AYMetersPerSecondSq',
    odometryPose: '/RealOutputs/Odometry/Robot',

    emergencyStop: '/DriverStation/EmergencyStop',
    matchTimeLeft: '/DriverStation/MatchTime',
    autoChoice: '/NetworkInputs/SmartDashboard/Autos',
    joystickButtonCounts: [0, 1, 2, 3, 4, 5].map((n) => `/DriverStation/Joystick${n}/ButtonCount`),
  },

  // This robot has no battery tracker. These are the 2026 keys (FRC8033BatteryTracker), kept so the code that
  // reads them has something to look up; none of them exists in a 2025 log, so battery-ID findings are "not checked".
  battery: {
    id: ['/RealOutputs/Battery/Id'],
    idSource: ['/RealOutputs/Battery/IdSource'],
    gaugeValid: ['/BatteryGauge/Valid', '/RealOutputs/BatteryGauge/Valid'],
    effectiveCapacityAh: ['/BatteryGauge/EffectiveCapacityAh', '/RealOutputs/BatteryGauge/EffectiveCapacityAh'],
    ratedCapacityAh: ['/BatteryGauge/RatedCapacityAh', '/RealOutputs/BatteryGauge/RatedCapacityAh'],
    remainingChargePct: ['/BatteryGauge/RemainingChargePct', '/RealOutputs/BatteryGauge/RemainingChargePct'],
    numCycles: ['/BatteryGauge/NumCycles', '/RealOutputs/BatteryGauge/NumCycles'],
  },

  power: {
    // Loads not on a motor controller (roboRIO, radio, coprocessors, CANivore). Assumed, as in the reference
    // script hindsight-research/whatif/battery_model_replay.py; nothing on the robot measures it.
    otherLoadsAmps: 3,
    restVoltageMin: 12.5,
    marginVolts: 1.0,
    healthyResistanceMaxOhms: 0.020,
  },

  // None of these motors logs a Connected flag (the Module / Pivot / Roller / Elevator inputs have no such field),
  // so no motor has a `connected` key. Every motor is on the CANivore ("*").
  motorGroups: [
    {
      name: 'Drive',
      motors: swerveModules.map((m) => ({
        name: `${m} drive`,
        canId: swerveIds[m][0],
        supplyCurrent: `/Swerve/${m} Module/DriveSupplyCurrentAmps`,
        statorCurrent: `/Swerve/${m} Module/DriveStatorCurrentAmps`,
        velocity: `/Swerve/${m} Module/DriveVelocityMetersPerSec`,
      })),
      limits: { supplyA: 40, supplyEnabled: true, statorA: 120, statorEnabled: true, where: 'OffseasonBotSwerveConstants.java:104-107', supplyLines: 'OffseasonBotSwerveConstants.java:104-105' },
    },
    {
      name: 'Steer',
      motors: swerveModules.map((m) => ({
        name: `${m} steer`,
        canId: swerveIds[m][1],
        supplyCurrent: `/Swerve/${m} Module/TurnSupplyCurrentAmps`,
        statorCurrent: `/Swerve/${m} Module/TurnStatorCurrentAmps`,
        velocity: `/Swerve/${m} Module/TurnVelocityRadPerSec`,
      })),
      // The code sets no stator limit for the steer motors, so the Phoenix 6 default applies (120 A, on).
      limits: { supplyA: 20, supplyEnabled: true, where: 'OffseasonBotSwerveConstants.java:72-73' },
    },
    {
      name: 'Elevator',
      sameLoop: true, // the follower (ID 11) is set to Follower(10), so both should move together
      motors: [
        {
          name: 'Elevator leader',
          canId: 10,
          supplyCurrent: '/Elevator/LeaderSupplyCurrentAmps',
          statorCurrent: '/Elevator/LeaderStatorCurrentAmps',
          velocity: '/Elevator/LeaderVelocityMetersPerSec',
        },
        {
          name: 'Elevator follower',
          canId: 11,
          supplyCurrent: '/Elevator/FollowerSupplyCurrentAmps',
          statorCurrent: '/Elevator/FollowerStatorCurrentAmps',
          velocity: '/Elevator/FollowerVelocityMetersPerSec',
        },
      ],
      // The same config is applied to both motors. After SupplyCurrentLowerTime at the 60 A limit the cap drops to 40 A.
      limits: {
        supplyA: 60, supplyEnabled: true, statorA: 80, statorEnabled: true,
        supplyLowerA: 40, supplyLowerSeconds: 0.25,
        where: 'ElevatorIOReal.java:59-64', supplyLines: 'ElevatorIOReal.java:61-64',
      },
    },
    {
      name: 'Arm pivot',
      motors: [{
        name: 'Arm pivot',
        canId: 9,
        supplyCurrent: '/Arm/Pivot/SupplyCurrentAmps',
        statorCurrent: '/Arm/Pivot/StatorCurrentAmps',
        velocity: '/Arm/Pivot/AngularVelocityRotsPerSec',
      }],
      // Values are ArmSubsystem.SUPPLY_CURRENT_LIMIT / STATOR_CURRENT_LIMIT (ArmSubsystem.java:35-36); the limits are
      // applied by createPivotConfig (Robot.java:644-648), called at Robot.java:164-174.
      limits: { supplyA: 40, supplyEnabled: true, statorA: 60, statorEnabled: true, where: 'ArmSubsystem.java:35-36', supplyLines: 'ArmSubsystem.java:35' },
    },
    {
      name: 'Arm roller',
      motors: [{
        name: 'Arm roller',
        canId: 8,
        supplyCurrent: '/Arm/Roller/SupplyCurrentAmps',
        statorCurrent: '/Arm/Roller/StatorCurrentAmps',
        velocity: '/Arm/Roller/VelocityRotsPerSec',
      }],
      // createRollerConfig sets only a supply limit (Robot.java:608-609), 20 A passed at Robot.java:161. No stator limit in code: the Phoenix 6 default (120 A, on) applies.
      limits: { supplyA: 20, supplyEnabled: true, where: 'Robot.java:161,608-609', supplyLines: 'Robot.java:161' },
    },
    {
      name: 'Intake pivot',
      motors: [{
        name: 'Intake pivot',
        canId: 12,
        supplyCurrent: '/Intake/Pivot/SupplyCurrentAmps',
        statorCurrent: '/Intake/Pivot/StatorCurrentAmps',
        velocity: '/Intake/Pivot/AngularVelocityRotsPerSec',
      }],
      // The robot builds this motor from IntakeSubsystem.getIntakePivotConfig() (Robot.java:243). Robot.java:225-226
      // (intakePivotConfig, also 40 / 80) is only used by the simulation.
      limits: { supplyA: 40, supplyEnabled: true, statorA: 80, statorEnabled: true, where: 'IntakeSubsystem.java:199-203', supplyLines: 'IntakeSubsystem.java:199-200' },
    },
    {
      name: 'Intake roller',
      motors: [{
        name: 'Intake roller',
        canId: 13,
        supplyCurrent: '/Intake/Roller/SupplyCurrentAmps',
        statorCurrent: '/Intake/Roller/StatorCurrentAmps',
        velocity: '/Intake/Roller/VelocityRotsPerSec',
      }],
      // Supply limit only (createRollerConfig, Robot.java:608-609); 80 A passed at Robot.java:218. No stator limit in code: the Phoenix 6 default (120 A, on) applies.
      limits: { supplyA: 80, supplyEnabled: true, where: 'Robot.java:218,608-609', supplyLines: 'Robot.java:218' },
    },
    {
      name: 'Climber pivot',
      motors: [{
        name: 'Climber pivot',
        canId: 14,
        supplyCurrent: '/Climber/Pivot/SupplyCurrentAmps',
        statorCurrent: '/Climber/Pivot/StatorCurrentAmps',
        velocity: '/Climber/Pivot/AngularVelocityRotsPerSec',
      }],
      // createPivotConfig is called with 20 A supply / 120 A stator (Robot.java:261-262), then
      // `.withCurrentLimits(new CurrentLimitsConfigs()...Enable(false))` replaces that block with both limits off
      // ("Disable both current limits!!!!!!!!!"), so the 20 A was never applied: the motor ran with no limit.
      limits: { supplyA: 20, supplyEnabled: false, statorA: 120, statorEnabled: false, where: 'Robot.java:261-262,270-274' },
    },
    {
      name: 'Climber roller',
      motors: [{
        name: 'Climber roller',
        canId: 15,
        supplyCurrent: '/Climber/Roller/SupplyCurrentAmps',
        statorCurrent: '/Climber/Roller/StatorCurrentAmps',
        velocity: '/Climber/Roller/VelocityRotsPerSec',
      }],
      // Supply limit only (createRollerConfig, Robot.java:608-609); 20 A passed at Robot.java:256. No stator limit in code: the Phoenix 6 default (120 A, on) applies.
      limits: { supplyA: 20, supplyEnabled: true, where: 'Robot.java:256,608-609', supplyLines: 'Robot.java:256' },
    },
  ],

  // Only the Pigeon (ID 0) logs a connected flag. The four swerve CANcoders (IDs 0-3, /Swerve/<module> Module/
  // CancoderAbsolutePosition), the arm CANcoder (ID 4, /Arm/CANcoder/CancoderPositionRotations) and the two intake
  // CANranges (IDs 0 and 1) log positions or distances but no connected flag, so they are not listed.
  otherDevices: [{ name: 'Gyro (Pigeon)', connected: '/Swerve/Gyro/IsConnected' }],

  // Every CAN device is on the CANivore ("*": GyroIOReal.java:28, ModuleIOReal.java:60-62 and the subsystems). Only the
  // Pigeon and the swerve modules report their health: each module logs BaseStatusSignal.refreshAll over its drive
  // TalonFX, steer TalonFX and CANcoder signals as "Module<name>refresh status code" (ModuleIOReal.java:130).
  // Superstructure.java logs its state and the drivers' requests (@AutoLogOutput, 493666f:232-250; the Algae Intake
  // Request is commented out there but logged by the Friday builds); the "Has Game Piece" flags and the intake
  // CANranges are what a state can wait for. PRE_CLIMB holds 29-39 s by design (MTTD 2025).
  stateMachine: {
    name: 'Superstructure',
    state: '/RealOutputs/Superstructure/State',
    idle: ['IDLE'],
    waitsOnPurpose: ['PRE_CLIMB'],
    requests: ['Score', 'Pre Score', 'Coral Intake', 'Algae Intake'].map((r) => ({ name: `${r} request`, key: `/RealOutputs/Superstructure/${r} Request` })),
    sensors: [
      { name: 'Arm has game piece', key: '/RealOutputs/Arm/Has Game Piece' },
      { name: 'Intake has game piece', key: '/RealOutputs/Intake/Has Game Piece' },
      { name: 'Superstructure: arm has game piece', key: '/RealOutputs/Superstructure/Arm Has Game Piece?' },
      { name: 'Superstructure: intake has game piece', key: '/RealOutputs/Superstructure/Intake Has Game Piece?' },
      { name: 'Left intake CANrange detects', key: '/Intake/Left CANrange/IsDetected' },
      { name: 'Right intake CANrange detects', key: '/Intake/Right CANrange/IsDetected' },
    ],
  },

  canBuses: [{
    name: 'CANivore',
    members: [
      { name: 'Gyro (Pigeon)', key: '/Swerve/Gyro/IsConnected' },
      ...swerveModules.map((m) => ({ name: `${m} module`, key: `/RealOutputs/Module${m}refresh status code`, ok: 'OK' })),
    ],
  }],

  // The what-if sliders cap this group's supply current per motor. The intake roller has the largest per-motor
  // supply charge and peak (115 A against an 80 A limit) in the 11 match logs of the Nov 2025 event.
  whatIfGroup: 'Intake roller',

  // The code zeroes the intake pivot and the elevator by driving into a hard stop until the filtered stator current
  // passes a threshold, then printing "<X> Zeroed". The arm is left out: its normal zero is from its CANcoder
  // (driver X, Robot.java:896 -> ArmSubsystem.rezeroFromEncoder) and prints nothing; "Arm Zeroed" comes only from the
  // manual operator sequence (Robot.java:860-873), so "moved before its zero" would fire on every match.
  // The pit crew also zeroes with the dashboard buttons ("dashboard rezero intake" etc., disabled, no current
  // detection), so both messages count as done.
  // The elevator (a linear mechanism, logged in meters) cannot be expressed here: this list is in degrees.
  zeroing: [
    {
      mechanism: 'Intake pivot',
      position: '/Intake/Pivot/Position', // a Rotation2d, which the reader gives in radians
      positionToDegrees: 180 / Math.PI,
      doneMessage: /Intake Zeroed|dashboard rezero intake/,
      moveDegrees: 3,
      zeroDirection: 'down', // runCurrentZeroing drives the pivot at -5 V into its stop
      zeroCurrent: {
        statorCurrent: '/Intake/Pivot/StatorCurrentAmps',
        thresholdA: 60, // IntakeSubsystem.CURRENT_THRESHOLD, 10-sample average, debounced 0.25 s
        statorLimitA: 80,
        where: 'IntakeSubsystem.java:50 (CURRENT_THRESHOLD), stator limit IntakeSubsystem.java:202',
      },
    },
  ],

  // Four PhotonVision cameras (OffseasonBotSwerveConstants.java:295-330). The camera inputs log only `Result` and
  // `Stale`, so `connected` is the likely AdvantageKit name and does not exist in any 2025 log.
  cameras: ['Left_Drivebase', 'Right_Drivebase', 'Left_Elevator', 'Right_Elevator'].map((name) => ({
    name,
    acceptedPose: `/RealOutputs/Vision/${name}/Pose2d`,
    stale: `/Apriltag Vision/${name}/Stale`,
    connected: `/Apriltag Vision/${name}/Connected`,
  })),
}
