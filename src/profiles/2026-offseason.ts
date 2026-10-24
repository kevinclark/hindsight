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

import { ADVANTAGEKIT_SIGNALS } from './advantagekit.ts'
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

const robot: RobotProfile = {
  name: '2026 offseason robot',
  team: 8033,
  codebase: '2026 Offseason',
  code: { repo: 'HighlanderRobotics/2026-Offseason-Robot', branch: 'main', sha: 'cb68b20' },

  // Field size from the robot code's tag layout (src/main/deploy/tagmaps/2026-rebuilt-andymark.json at cb68b20).
  game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140, field: { length: 16.518, width: 8.043 } },

  signals: {
    ...ADVANTAGEKIT_SIGNALS,
    alertGroups: ['/RealOutputs/Alerts', '/RealOutputs/PhotonAlerts', '/RealOutputs/Choreo Alerts'],

    gyroPitch: '/Swerve/Gyro/Pitch',
    gyroRoll: '/Swerve/Gyro/Roll',
    accelX: '/Swerve/Gyro/AXMetersPerSecondSq',
    accelY: '/Swerve/Gyro/AYMetersPerSecondSq',
    odometryPose: '/RealOutputs/Odometry/Robot',

    autoChoice: '/NetworkInputs/SmartDashboard/Autos',
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
        temperature: `/Swerve/${m} Module/DriveTempC`,
        updating: `/Swerve/${m} Module/DriveStatorCurrentAmps`,
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
        temperature: `/Swerve/${m} Module/TurnTempC`,
        updating: `/Swerve/${m} Module/TurnStatorCurrentAmps`,
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
          temperature: '/Drum/Flywheel/Leader/TempC',
          // No `updating`: at rest every flywheel signal sits unchanged for minutes (stator current too).
        },
        // Followers 16, 17, 18: DrumSubsystem.java:109, 112, 115.
        ...[0, 1, 2].map((i) => ({
          name: `Flywheel follower ${16 + i}`,
          canId: 16 + i,
          supplyCurrent: `/Drum/Flywheel/Follower ${i}/SupplyCurrentAmps`,
          statorCurrent: `/Drum/Flywheel/Follower ${i}/StatorCurrentAmps`,
          velocity: `/Drum/Flywheel/Follower ${i}/VelocityRotPerSec`,
          connected: `/Drum/Flywheel/Follower ${i}/Connected`,
          temperature: `/Drum/Flywheel/Follower ${i}/TempC`,
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
        temperature: '/Drum/Hood/TempC',
        updating: '/Drum/Hood/StatorCurrentAmps',
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
        temperature: '/Intake/Pivot/TempC',
        updating: '/Intake/Pivot/StatorCurrentAmps',
      }],
      limits: { supplyA: 40, supplyEnabled: false, statorA: 50, statorEnabled: true, where: 'SlapdownSubsystem.java:266' },
    },
    {
      name: 'Intake rollers',
      // Leader 9 (Robot.java:76), follower 10 (SlapdownSubsystem.java:86).
      // The two rollers name their temperature differently in the log.
      motors: [{ m: 'Leader', canId: 9, temp: 'TemperatureCelsius' }, { m: 'Follower', canId: 10, temp: 'TempC' }].map(({ m, canId, temp }) => ({
        name: `Intake roller ${m.toLowerCase()}`,
        canId,
        supplyCurrent: `/Intake/Roller ${m}/SupplyCurrentAmps`,
        statorCurrent: `/Intake/Roller ${m}/StatorCurrentAmps`,
        connected: `/Intake/Roller ${m}/Connected`,
        temperature: `/Intake/Roller ${m}/${temp}`,
        updating: `/Intake/Roller ${m}/StatorCurrentAmps`,
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
        temperature: `${m.prefix}TempC`,
        updating: `${m.prefix}StatorCurrentAmp`,
      })),
      limits: { supplyA: 40, supplyEnabled: true, statorA: 60, statorEnabled: true, where: 'IndexerIO.java:170' },
    },
  ],

  // Other devices whose */Connected flag matters (encoders, gyro). Motors' flags come from motorGroups.
  // `updating` (foresight/values-updating): the gyro's yaw rate changes every loop at rest; the CANcoders have nothing
  // that does (a still CANcoder's position sat unchanged for up to 110 s in the 2026 logs).
  otherDevices: [
    ...swerveModules.map((m) => ({ name: `${m} CANcoder`, connected: `/Swerve/${m} Module/CancoderConnected` })),
    { name: 'Intake CANcoder', connected: '/Intake/CANcoder/Connected' },
    { name: 'Gyro (Pigeon)', connected: '/Swerve/Gyro/IsConnected', updating: '/Swerve/Gyro/YawVelocityRadPerSec' },
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
      // "Rezeroed hood" is the on-enable current zero (logs A and B code); "Hood zeroed!" is the zero at boot (8ba92cb).
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

  // `acceptedPose` is logged only when the code made a pose from the coprocessor's multi-tag result
  // (Camera.updateCamera, estimateCoprocMultiTagPose), i.e. two or more tags in view: in the 2026 logs 0 of 19,095
  // one-tag results logged a pose, and all 20,873 with two or more did. `result` says what the camera saw.
  cameras: [
    {
      name: 'Back_Left',
      acceptedPose: '/RealOutputs/Vision/Back_Left/Pose2d',
      result: '/Apriltag VisionBack_Left/Result',
      stale: '/Apriltag VisionBack_Left/Stale',
      connected: '/Apriltag VisionBack_Left/Connected',
    },
    {
      name: 'Back_Right',
      acceptedPose: '/RealOutputs/Vision/Back_Right/Pose2d',
      result: '/Apriltag VisionBack_Right/Result',
      stale: '/Apriltag VisionBack_Right/Stale',
      connected: '/Apriltag VisionBack_Right/Connected',
    },
  ],

  foresight: {
    // Two Xbox controllers, on ports 0 and 1, in all three 2026 match logs.
    controllerNames: [0, 1].map((port) => `/DriverStation/Joystick${port}/Name`),
    gyroYaw: '/Swerve/Gyro/Yaw',
    zeroChecks: [
      {
        mechanism: 'Intake pivot',
        absolute: '/Intake/CANcoder/CancoderPositionRotations', // a Rotation2d, so radians despite the name
        absoluteUnit: 'radians',
        motor: '/Intake/Pivot/PositionRotations',
        // CANCODER_TO_PIVOT = 1.77777778 (event-calgames). Measured in the 2026 logs at rest: CANcoder 0.6536 rot,
        // pivot 0.3677 rot (0.6536 / 1.7778 = 0.3677).
        sensorToMechanism: 1.77777778,
        where: 'SlapdownSubsystem.java: CANCODER_TO_PIVOT, and getPivotConfig() (RemoteCANcoder ID 4, SensorToMechanismRatio)',
      },
      { mechanism: 'Hood', notCheckable: 'the hood has no absolute encoder in the log, so its zero can only be checked once the robot code logs a "zeroed" flag' },
    ],
    // From the code at cb68b20. The same values at event-calgames d339f29: DumperSwerveConstants.java is identical there;
    // only the intake lines moved (offseason2026Event overrides that `where`).
    snapshot: {
      devices: [
        // ModuleConstants(..., cancoderID, offset): CANcoders 0-3, each read by its module's steer motor
        // (getTurnConfig: FeedbackRemoteSensorID = cancoderID, DumperSwerveConstants.java:214). An offset written as
        // fromRotations(x).plus(k180deg) is applied as x + 0.5 wrapped into -0.5..0.5 (Rotation2d.getRotations()).
        ...swerveModules.map((m, i) => ({
          name: `${m} CANcoder`,
          model: 'CANcoder' as const,
          canId: i,
          magnetOffset: [-0.337646 + 0.5, -0.145264, -0.42627 + 0.5, 0.4548 + 0.5 - 1][i],
          readBy: swerveCanIds[m].steer,
          where: `DumperSwerveConstants.java:${[127, 132, 138, 144][i]}`,
        })),
        { name: 'Intake CANcoder', model: 'CANcoder', canId: 4, magnetOffset: -0.4106, readBy: 8, where: 'SlapdownSubsystem.java:309 (getCancoderConfig), Robot.java:75' },
        { name: 'Gyro (Pigeon)', model: 'Pigeon 2', canId: 0, where: 'DumperSwerveConstants.java getGyroID()' },
      ],
      ratios: [
        // SDS Mk5n R2: 6.03 motor turns per wheel turn, 2 in wheel radius (SwerveConstants.java:114), so motor
        // rotations per meter of travel.
        { group: 'Drive', sensorToMechanism: 6.03 / (2 * Math.PI * 0.0508), where: 'DumperSwerveConstants.java:109 (gear ratio) and :184 (SensorToMechanismRatio)' },
        // Mk5n steer 287/11, fused with the CANcoder: the ratio is rotor-to-sensor, sensor-to-mechanism 1.
        { group: 'Steer', rotorToSensor: 287 / 11, sensorToMechanism: 1, where: 'DumperSwerveConstants.java:115 (gear ratio) and :215-216' },
      ],
    },
  },
}

/**
 * Every device that reports a Connected flag, as members of the one bus (see the header: one CANivore for all of
 * them). A whole-bus drop is then one finding about the CANivore, not one per device (can/bus-dropout).
 */
const connectedMembers = [
  ...robot.motorGroups.flatMap((g) => g.motors.flatMap((m) => (m.connected ? [{ name: m.name, key: m.connected }] : []))),
  ...robot.otherDevices.map((d) => ({ name: d.name, key: d.connected })),
]

export const offseason2026: RobotProfile = { ...robot, canBuses: [{ name: 'CANivore', members: connectedMembers }] }

/**
 * The same robot, running the code from the October 2026 event: branch `event-calgames`, head
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
  ...offseason2026, // incl. canBuses: this profile reuses the base motor objects, so the bus members stay in step; if a motor is renamed here, rebuild the bus
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

  // The intake CANcoder's lines moved at d339f29: MagnetOffset SlapdownSubsystem.java:329, its reader (Talon FX 8,
  // FeedbackRemoteSensorID = 4) :272, and CANcoderIO(4…) Robot.java:76. Values unchanged.
  foresight: {
    ...offseason2026.foresight!,
    snapshot: {
      ...offseason2026.foresight!.snapshot!,
      devices: offseason2026.foresight!.snapshot!.devices.map((d) => (d.name === 'Intake CANcoder' ? { ...d, where: 'SlapdownSubsystem.java:329 (getCancoderConfig), Robot.java:76' } : d)),
    },
  },

  zeroing: offseason2026.zeroing.map((z) =>
    z.zeroCurrent
      ? { ...z, zeroCurrent: { ...z.zeroCurrent, where: 'DrumSubsystem.java:53 (HOOD_CURRENT_ZEROING_THRESHOLD_AMPS), stator limit DrumSubsystem.java:342' } }
      : z),
}
