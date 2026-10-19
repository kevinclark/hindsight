/**
 * Robot profile for team 8033's 2026 offseason robot (HighlanderRobotics/2026-Offseason-Robot).
 *
 * Rules never hard-code a log key. They ask this file, so a new robot or a renamed subsystem means editing
 * this file, not the rules. Copy it for next season's robot.
 *
 * Current limits are copied from the robot code at `main` cb68b20 (2026-10-19). `...Enabled: false` means the
 * limit is configured in code but switched off, which is itself a finding (power/limit-not-applied).
 */

import type { MotorGroup, RobotProfile } from './types.ts'

const swerveModules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']

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
        supplyCurrent: `/Swerve/${m} Module/DriveSupplyCurrentAmps`,
        statorCurrent: `/Swerve/${m} Module/DriveStatorCurrentAmps`,
        connected: `/Swerve/${m} Module/DriveConnected`,
      })),
      limits: { supplyA: 40, supplyEnabled: true, statorA: 120, statorEnabled: true, where: 'AlphaSwerveConstants.java:144' },
    },
    {
      name: 'Steer',
      motors: swerveModules.map((m) => ({
        name: `${m} steer`,
        supplyCurrent: `/Swerve/${m} Module/TurnSupplyCurrentAmps`,
        statorCurrent: `/Swerve/${m} Module/TurnStatorCurrentAmps`,
        connected: `/Swerve/${m} Module/TurnConnected`,
      })),
      limits: { supplyA: 20, supplyEnabled: true, where: 'AlphaSwerveConstants.java:176' },
    },
    {
      name: 'Flywheel',
      sameLoop: true, // the followers copy the leader's output, so all four should spin at the same speed
      motors: [
        {
          name: 'Flywheel leader',
          canId: 15,
          supplyCurrent: '/Drum/Flywheel/Leader/SupplyCurrentAmps',
          statorCurrent: '/Drum/Flywheel/Leader/StatorCurrentAmps',
          velocity: '/Drum/Flywheel/Leader/VelocityRotPerSec',
          connected: '/Drum/Flywheel/Leader/Connected',
        },
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
        supplyCurrent: '/Intake/Pivot/SupplyCurrentAmps',
        statorCurrent: '/Intake/Pivot/StatorCurrentAmps',
        connected: '/Intake/Pivot/Connected',
      }],
      limits: { supplyA: 40, supplyEnabled: false, statorA: 50, statorEnabled: true, where: 'SlapdownSubsystem.java:266' },
    },
    {
      name: 'Intake rollers',
      motors: ['Leader', 'Follower'].map((m) => ({
        name: `Intake roller ${m.toLowerCase()}`,
        supplyCurrent: `/Intake/Roller ${m}/SupplyCurrentAmps`,
        statorCurrent: `/Intake/Roller ${m}/StatorCurrentAmps`,
        connected: `/Intake/Roller ${m}/Connected`,
      })),
      limits: { supplyA: 40, supplyEnabled: false, statorA: 20, statorEnabled: true, where: 'SlapdownSubsystem.java:294' },
    },
    {
      name: 'Indexer',
      motors: [
        { name: 'Indexer', prefix: '/Indexer/Indexer' },
        { name: 'Kicker leader', prefix: '/Indexer/KickerLeader' },
        { name: 'Kicker follower', prefix: '/Indexer/KickerFollower' },
      ].map((m) => ({
        name: m.name,
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
}

/**
 * The same robot, running the code from the October 2026 event (CalGames): branch `event-calgames`, head
 * d339f29 (2026-10-18 10:21 PDT, "reduce supply current indexer"). The event logs came from 45e3eba, fb5f9b7 and
 * 123eec6, all ancestors of this head; later commits are 96479a0 and d339f29. Compared with main cb68b20:
 *  - The kickers' supply limit is 30 A, not 40 A (IndexerIO.java:198, commit d339f29). The indexer feed motor
 *    stays at 40 A, so the old "Indexer" group is split in two.
 *  - Every other current limit, CAN ID and logged motor/camera key is the same as main.
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
  code: { repo: 'HighlanderRobotics/2026-Offseason-Robot', branch: 'event-calgames', sha: 'd339f29' },

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
