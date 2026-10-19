/**
 * Robot profile for team 8033's 2026 offseason robot (HighlanderRobotics/2026-Offseason-Robot).
 *
 * Rules never hard-code a log key. They ask this file, so a new robot or a renamed subsystem means editing
 * this file, not the rules. Copy it for next season's robot.
 *
 * Current limits are copied from the robot code at `main` cb68b20 (2026-10-19). `...Enabled: false` means the
 * limit is configured in code but switched off, which is itself a finding (power/limit-not-applied).
 *
 * CAN IDs are from the same commit. Every device is on one bus: Robot.java:61 builds `new CANBus("*")` (the first
 * CANivore found) and passes it to every subsystem, so no ID needs a bus to tell it apart.
 */

import type { MotorGroup, RobotProfile } from './types.ts'

const swerveModules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']

// Drive and turn Talon FX IDs per module: DumperSwerveConstants.java:127, 132, 138, 144 (SwerveSubsystem.java:75 picks
// DumperSwerveConstants), as ModuleConstants(id, prefix, driveID, turnID, cancoderID, offset).
const swerveCanIds: Record<string, { drive: number; steer: number }> = {
  'Front Left': { drive: 0, steer: 1 },
  'Front Right': { drive: 2, steer: 3 },
  'Back Left': { drive: 4, steer: 5 },
  'Back Right': { drive: 6, steer: 7 },
}

export const offseason2026: RobotProfile = {
  name: '2026 offseason robot',
  codebase: '2026 Offseason',
  code: { repo: 'HighlanderRobotics/2026-Offseason-Robot', branch: 'main', sha: 'cb68b20' },

  game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 },

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

    gyroPitch: '/Swerve/Gyro/Pitch',
    gyroRoll: '/Swerve/Gyro/Roll',
    accelX: '/Swerve/Gyro/AXMetersPerSecondSq',
    accelY: '/Swerve/Gyro/AYMetersPerSecondSq',
    odometryPose: '/RealOutputs/Odometry/Robot',
  },

  // FRC8033BatteryTracker (kevinclark/8033-battery-tracker). Outputs are under /RealOutputs; the gauge is logged
  // with Logger.processInputs("BatteryGauge"), which AdvantageKit writes at the log root. Both places are tried.
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

  motorGroups: [
    {
      name: 'Drive',
      motors: swerveModules.map((m) => ({
        name: `${m} drive`,
        canId: swerveCanIds[m].drive,
        supplyCurrent: `/Swerve/${m} Module/DriveSupplyCurrentAmps`,
        statorCurrent: `/Swerve/${m} Module/DriveStatorCurrentAmps`,
        connected: `/Swerve/${m} Module/DriveConnected`,
      })),
      limits: { supplyA: 40, supplyEnabled: true, statorA: 120, statorEnabled: true, where: 'DumperSwerveConstants.java:175-178' },
    },
    {
      name: 'Steer',
      motors: swerveModules.map((m) => ({
        name: `${m} steer`,
        canId: swerveCanIds[m].steer,
        supplyCurrent: `/Swerve/${m} Module/TurnSupplyCurrentAmps`,
        statorCurrent: `/Swerve/${m} Module/TurnStatorCurrentAmps`,
        connected: `/Swerve/${m} Module/TurnConnected`,
      })),
      limits: { supplyA: 20, supplyEnabled: true, where: 'DumperSwerveConstants.java:207-208' },
    },
    {
      name: 'Flywheel',
      sameLoop: true, // the followers copy the leader's output, so all four should spin at the same speed
      motors: [
        {
          name: 'Flywheel leader',
          canId: 15, // DrumSubsystem.java:45 (FLYWHEEL_LEADER_ID)
          supplyCurrent: '/Drum/Flywheel/Leader/SupplyCurrentAmps',
          statorCurrent: '/Drum/Flywheel/Leader/StatorCurrentAmps',
          velocity: '/Drum/Flywheel/Leader/VelocityRotPerSec',
          connected: '/Drum/Flywheel/Leader/Connected',
        },
        // Followers 16, 17, 18: DrumSubsystem.java:109, 112, 115.
        ...[0, 1, 2].map((i) => ({
          name: `Flywheel follower ${16 + i}`,
          canId: 16 + i,
          supplyCurrent: `/Drum/Flywheel/Follower ${i}/SupplyCurrentAmps`,
          statorCurrent: `/Drum/Flywheel/Follower ${i}/StatorCurrentAmps`,
          velocity: `/Drum/Flywheel/Follower ${i}/VelocityRotPerSec`,
          connected: `/Drum/Flywheel/Follower ${i}/Connected`,
        })),
      ],
      limits: { supplyA: 40, supplyEnabled: false, statorA: 75, statorEnabled: true, where: 'DrumSubsystem.java:307-310', supplyLines: 'DrumSubsystem.java:309-310' },
      // The setpoint is only logged while spinning; between shots it stays at its last value while the wheel coasts.
      // The leader's applied voltage says whether it is being driven.
      spinUp: { setpoint: '/RealOutputs/Drum/Flywheel/Setpoint', appliedVolts: '/Drum/Flywheel/Leader/Voltage' },
    },
    {
      name: 'Hood',
      motors: [{
        name: 'Hood',
        canId: 14, // HoodIO.java:51
        supplyCurrent: '/Drum/Hood/SupplyCurrentAmps',
        statorCurrent: '/Drum/Hood/StatorCurrentAmps',
        connected: '/Drum/Hood/Connected',
      }],
      limits: { supplyA: 40, supplyEnabled: false, statorA: 30, statorEnabled: true, where: 'DrumSubsystem.java:334-337' },
    },
    {
      name: 'Intake pivot',
      motors: [{
        name: 'Intake pivot',
        canId: 8, // Robot.java:74
        supplyCurrent: '/Intake/Pivot/SupplyCurrentAmps',
        statorCurrent: '/Intake/Pivot/StatorCurrentAmps',
        connected: '/Intake/Pivot/Connected',
      }],
      limits: { supplyA: 40, supplyEnabled: false, statorA: 50, statorEnabled: true, where: 'SlapdownSubsystem.java:266' },
    },
    {
      name: 'Intake rollers',
      // Leader 9 (Robot.java:76), follower 10 (SlapdownSubsystem.java:86).
      motors: [{ m: 'Leader', canId: 9 }, { m: 'Follower', canId: 10 }].map(({ m, canId }) => ({
        name: `Intake roller ${m.toLowerCase()}`,
        canId,
        supplyCurrent: `/Intake/Roller ${m}/SupplyCurrentAmps`,
        statorCurrent: `/Intake/Roller ${m}/StatorCurrentAmps`,
        connected: `/Intake/Roller ${m}/Connected`,
      })),
      limits: { supplyA: 40, supplyEnabled: false, statorA: 20, statorEnabled: true, where: 'SlapdownSubsystem.java:294' },
    },
    {
      name: 'Indexer',
      motors: [
        // IndexerIO.java:86, 89, 92.
        { name: 'Indexer', prefix: '/Indexer/Indexer', canId: 11 },
        { name: 'Kicker leader', prefix: '/Indexer/KickerLeader', canId: 12 },
        { name: 'Kicker follower', prefix: '/Indexer/KickerFollower', canId: 13 },
      ].map((m) => ({
        name: m.name,
        canId: m.canId,
        supplyCurrent: `${m.prefix}SupplyCurrentAmp`,
        statorCurrent: `${m.prefix}StatorCurrentAmp`,
        connected: `${m.prefix}Connected`,
      })),
      limits: { supplyA: 40, supplyEnabled: true, statorA: 60, statorEnabled: true, where: 'IndexerIO.java:170' },
    },
  ],

  // Other devices whose */Connected flag matters (encoders, gyro). Motors' flags come from motorGroups.
  otherDevices: [
    ...swerveModules.map((m) => ({ name: `${m} CANcoder`, connected: `/Swerve/${m} Module/CancoderConnected` })),
    { name: 'Intake CANcoder', connected: '/Intake/CANcoder/Connected' },
    { name: 'Gyro (Pigeon)', connected: '/Swerve/Gyro/IsConnected' },
  ],

  // The what-if sliders cap this group's supply current per motor.
  whatIfGroup: 'Flywheel',
  // A CTRE PDP 2.0, from the 2025-26 purchase record and the team's word (not inspected on the robot): it has no
  // current telemetry, so per-channel current isn't logged.
  powerDistribution: 'ctre-pdp-2',

  zeroing: [
    {
      mechanism: 'Hood',
      position: '/Drum/Hood/PositionRotations',
      positionToDegrees: 360,
      // "Rezeroed hood" is the on-enable current zero (Q13/Q21 code); "Hood zeroed!" is the zero at boot (8ba92cb).
      doneMessage: /Rezeroed hood|Hood zeroed/,
      moveDegrees: 3,
      zeroDirection: 'down', // the current zero drives the hood into its bottom hard stop
      zeroCurrent: {
        statorCurrent: '/Drum/Hood/StatorCurrentAmps',
        thresholdA: 30, // HOOD_CURRENT_ZEROING_THRESHOLD_AMPS
        statorLimitA: 30,
        where: 'DrumSubsystem.java:53 (HOOD_CURRENT_ZEROING_THRESHOLD_AMPS), stator limit DrumSubsystem.java:334',
      },
    },
  ],

  cameras: [
    {
      name: 'Back_Left',
      acceptedPose: '/RealOutputs/Vision/Back_Left/Pose2d',
      stale: '/Apriltag VisionBack_Left/Stale',
      connected: '/Apriltag VisionBack_Left/Connected',
    },
    {
      name: 'Back_Right',
      acceptedPose: '/RealOutputs/Vision/Back_Right/Pose2d',
      stale: '/Apriltag VisionBack_Right/Stale',
      connected: '/Apriltag VisionBack_Right/Connected',
    },
  ],

  foresight: {
    // Two Xbox controllers, on ports 0 and 1, in all three CalGames match logs.
    controllers: 2,
    gyroYaw: '/Swerve/Gyro/Yaw',
    zeroChecks: [
      {
        mechanism: 'Intake pivot',
        absolute: '/Intake/CANcoder/CancoderPositionRotations', // a Rotation2d, so radians despite the name
        absoluteUnit: 'radians',
        motor: '/Intake/Pivot/PositionRotations',
        // CANCODER_TO_PIVOT = 1.77777778 (event-calgames). Measured in the CalGames logs at rest: CANcoder 0.6536 rot,
        // pivot 0.3677 rot (0.6536 / 1.7778 = 0.3677).
        sensorToMechanism: 1.77777778,
        where: 'SlapdownSubsystem.java: CANCODER_TO_PIVOT, and getPivotConfig() (RemoteCANcoder ID 4, SensorToMechanismRatio)',
      },
      { mechanism: 'Hood', notCheckable: 'the hood has no absolute encoder in the log, so its zero can only be checked once the robot code logs a "zeroed" flag' },
    ],
  },
}

/**
 * The same robot, running the code from the October 2026 event (CalGames): branch `event-calgames`, head
 * d339f29 (2026-10-18 10:21 PDT, "reduce supply current indexer"). The event logs came from 45e3eba, fb5f9b7 and
 * 123eec6, all ancestors of this head; later commits are 96479a0 and d339f29. Compared with main cb68b20:
 *  - The kickers' supply limit is 30 A, not 40 A (IndexerIO.java:198, commit d339f29). The indexer feed motor
 *    stays at 40 A, so the old "Indexer" group is split in two.
 *  - Every other current limit, CAN ID and logged motor/camera key is the same as main. The CAN IDs were checked at
 *    d339f29: the same values, with three moved lines (Robot.java:75 pivot, Robot.java:77 roller leader,
 *    SlapdownSubsystem.java:95 roller follower); the bus is still `new CANBus("*")` (Robot.java:62).
 *  - Limits that moved to new lines because code was added above them: DrumSubsystem.java (+8 lines) and
 *    SlapdownSubsystem.java (+20 lines).
 *  - Hood zeroing: the event code also zeroes the hood once at boot (Robot.robotInit) and has a "Zero hood to
 *    bottom" dashboard button, both of which print "Hood zeroed! - Hood IO". The existing doneMessage matches it.
 *  - The Pigeon acceleration keys (accelX / accelY) are only logged by the event code, not by main cb68b20.
 * Flywheel supply limit: still 40 A with the enable flag false at this head (DrumSubsystem.java:317-318).
 */
function eventGroup(name: string): MotorGroup {
  const group = offseason2026.motorGroups.find((g) => g.name === name)
  if (!group) throw new Error(`offseason2026 has no motor group "${name}"`)
  return group
}

const mainIndexerMotors = eventGroup('Indexer').motors

export const offseason2026Event: RobotProfile = {
  ...offseason2026,
  // event-calgames-new-autos was merged into event-calgames (at 123eec6), so its logs ran this code too.
  code: { repo: 'HighlanderRobotics/2026-Offseason-Robot', branch: 'event-calgames', sha: 'd339f29', alsoBranches: ['event-calgames-new-autos'] },

  motorGroups: offseason2026.motorGroups.flatMap((group): MotorGroup[] => {
    switch (group.name) {
      case 'Flywheel':
        return [{ ...group, limits: { ...group.limits, where: 'DrumSubsystem.java:315-318', supplyLines: 'DrumSubsystem.java:317-318' } }]
      case 'Hood':
        return [{ ...group, limits: { ...group.limits, where: 'DrumSubsystem.java:342-345' } }]
      case 'Intake pivot':
        return [{ ...group, limits: { ...group.limits, where: 'SlapdownSubsystem.java:286' } }]
      case 'Intake rollers':
        return [{ ...group, limits: { ...group.limits, where: 'SlapdownSubsystem.java:314' } }]
      case 'Indexer':
        // Two configs in IndexerIO.java: the indexer feed motor (line 170) and the two kickers (line 196).
        return [
          { name: 'Indexer', motors: mainIndexerMotors.filter((m) => !m.name.startsWith('Kicker')), limits: { ...group.limits, where: 'IndexerIO.java:170-173' } },
          { name: 'Kicker', motors: mainIndexerMotors.filter((m) => m.name.startsWith('Kicker')), limits: { ...group.limits, supplyA: 30, where: 'IndexerIO.java:196-199' } },
        ]
      default:
        return [group]
    }
  }),

  zeroing: offseason2026.zeroing.map((z) =>
    z.zeroCurrent
      ? { ...z, zeroCurrent: { ...z.zeroCurrent, where: 'DrumSubsystem.java:53 (HOOD_CURRENT_ZEROING_THRESHOLD_AMPS), stator limit DrumSubsystem.java:342' } }
      : z),
}
