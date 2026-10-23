/**
 * Robot profile for team 8033's 2026 competition robot (HighlanderRobotics/Rebuilt): the REBUILT robot with a turret
 * shooter, its "COMP" edition (the code picks it from the roboRIO's serial number; logs say /RealOutputs/Robot Edition).
 *
 * Copied from the robot code on branch `comp-bring-up`, commit 2cd2843 (2026-02-21 13:41 PST). The practice logs of
 * 2026-02-20/21 ran 13 commits of that branch (7525889 to b675b5d, and two of them from `comp-bring-up-2-21`); none of
 * them changes a current limit, CAN ID, logged key, magnet offset or gear ratio, so this one profile fits them all.
 * 2cd2843 ran 12 of those logs, as many as 7525889 (11 Friday evening, one Saturday morning), and still has the
 * intake's current zero (b675b5d stubs the intake out).
 *
 * A limit the code never sets is left out and Phoenix 6's default applies; a supply limit set without its enable flag
 * is on (Phoenix's default for the flag).
 *
 * Every device is on one bus: Robot.java:178 builds `new CANBus("*")` (the first CANivore found) and passes it to every
 * subsystem.
 *
 * What changed on the robot during those logs:
 *  - The climber was taken out of the code at b197f9a (2026-02-21 11:09 PST, "Turn off climber bc broken"); from then
 *    on the code builds an EmptyClimberSubsystem and logs no /Climber keys. Its group stays here for the earlier logs;
 *    rules skip it where its keys are missing.
 */

import { ADVANTAGEKIT_SIGNALS } from './advantagekit.ts'
import type { RobotProfile } from './types.ts'

const swerveModules = ['Front Left', 'Front Right', 'Back Left', 'Back Right']

// R1WispSwerveConstants.java:174-191 (SwerveSubsystem.java:85 picks it for COMP), as
// ModuleConstants(id, prefix, driveID, turnID, cancoderID, offset).
const swerveCanIds: Record<string, { drive: number; steer: number; cancoder: number }> = {
  'Front Left': { drive: 0, steer: 1, cancoder: 0 },
  'Front Right': { drive: 2, steer: 3, cancoder: 1 },
  'Back Left': { drive: 4, steer: 5, cancoder: 2 },
  'Back Right': { drive: 6, steer: 7, cancoder: 3 },
}

/** A Talon FX logged by the code's RollerIO (indexer and intake rollers): the same key names under each prefix. */
const rollerMotor = (name: string, prefix: string, canId: number) => ({
  name,
  canId,
  supplyCurrent: `${prefix}/SupplyCurrentAmps`,
  statorCurrent: `${prefix}/StatorCurrentAmps`,
  velocity: `${prefix}/VelocityRotsPerSec`,
  connected: `${prefix}/Connected`,
  temperature: `${prefix}/TemperatureCelsius`,
  updating: `${prefix}/StatorCurrentAmps`,
})

export const competition2026: RobotProfile = {
  name: '2026 competition robot',
  codebase: 'Rebuilt',
  // Robot.java records which robot it built with recordMetadata("Robot Edition", …).
  editionKey: '/RealMetadata/Robot Edition',
  code: { repo: 'HighlanderRobotics/Rebuilt', branch: 'comp-bring-up', sha: '2cd2843', alsoBranches: ['comp-bring-up-2-21'] },

  // The code loads WPILib's default field (SwerveConstants.java:39): k2026RebuiltWelded in WPILib 2026.2.1, the
  // version build.gradle pins. Size from the code's 2026-rebuilt-welded.json.
  game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140, field: { length: 16.541, width: 8.069 } },

  signals: {
    ...ADVANTAGEKIT_SIGNALS,
    alertGroups: ['/RealOutputs/Alerts', '/RealOutputs/PhotonAlerts'],

    gyroPitch: '/Swerve/Gyro/Pitch',
    gyroRoll: '/Swerve/Gyro/Roll',
    // No gyro acceleration is logged: accelX and accelY stay empty.
    odometryPose: '/RealOutputs/Odometry/Robot',

    autoChoice: '/NetworkInputs/SmartDashboard/Autos',
  },

  // No battery tracker in this code.
  battery: { id: [], idSource: [], gaugeValid: [], effectiveCapacityAh: [], ratedCapacityAh: [], remainingChargePct: [], numCycles: [] },

  power: {
    // As in the 2026 offseason profile: assumed, nothing on the robot measures it.
    otherLoadsAmps: 3,
    restVoltageMin: 12.5,
    marginVolts: 1.0,
    healthyResistanceMaxOhms: 0.020,
  },

  // `updating`: every motor's stator current changed at rest in the 55 logs of 2026-02-20/21 (longest gap between
  // records while disabled 2.4 s, the flywheels' 0.1 s).
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
      limits: { supplyA: 40, supplyEnabled: true, statorA: 120, statorEnabled: true, where: 'R1WispSwerveConstants.java:212-215' },
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
      limits: { supplyA: 20, supplyEnabled: true, where: 'R1WispSwerveConstants.java:244-245' },
    },
    {
      name: 'Flywheel',
      sameLoop: true, // the follower copies the leader, turning the opposite way (FlywheelIO.java:82-83, Opposed)
      // FlywheelIO(config, canivore, 12, 13): Robot.java:358.
      motors: (['Leader', 'Follower'] as const).map((m, i) => ({
        name: `Flywheel ${m.toLowerCase()}`,
        canId: 12 + i,
        supplyCurrent: `/Shooter/Flywheel/Flywheel${m}SupplyCurrentAmp`,
        statorCurrent: `/Shooter/Flywheel/Flywheel${m}StatorCurrentAmps`,
        velocity: `/Shooter/Flywheel/Flywheel${m}VelocityRotationsPerSecond`,
        connected: `/Shooter/Flywheel/Flywheel${m}Connected`,
        temperature: `/Shooter/Flywheel/Flywheel${m}TempC`,
        updating: `/Shooter/Flywheel/Flywheel${m}StatorCurrentAmps`,
      })),
      limits: { supplyA: 40, supplyEnabled: true, statorA: 120, statorEnabled: false, where: 'TurretSubsystem.java:529-531', supplyLines: 'TurretSubsystem.java:531' },
      // The setpoint keeps its last value between shots; the leader's applied voltage says whether it is being driven.
      spinUp: { setpoint: '/RealOutputs/Shooter/Setpoint', appliedVolts: '/Shooter/Flywheel/FlywheelLeaderVoltage' },
    },
    {
      name: 'Hood',
      motors: [{
        name: 'Hood',
        canId: 11, // Robot.java:366
        supplyCurrent: '/Shooter/Hood/HoodSupplyCurrentAmp',
        statorCurrent: '/Shooter/Hood/HoodStatorCurrentAmps',
        connected: '/Shooter/Hood/Connected',
        temperature: '/Shooter/Hood/HoodTempC',
        updating: '/Shooter/Hood/HoodStatorCurrentAmps',
      }],
      limits: { supplyA: 60, supplyEnabled: true, statorA: 80, statorEnabled: true, where: 'TurretSubsystem.java:555-557' },
    },
    {
      name: 'Turret',
      motors: [{
        name: 'Turret',
        canId: 15, // TurretIO.java:52
        supplyCurrent: '/Shooter/Turret/SupplyCurrentAmp',
        statorCurrent: '/Shooter/Turret/StatorCurrentAmps',
        velocity: '/Shooter/Turret/AngularVelocityRotationsPerSec',
        connected: '/Shooter/Turret/Connected',
        temperature: '/Shooter/Turret/TempCelsius',
        updating: '/Shooter/Turret/StatorCurrentAmps',
      }],
      limits: { supplyA: 40, supplyEnabled: true, statorA: 40, statorEnabled: true, where: 'TurretIO.java:58-61' },
      // Nothing for the turret to hold. Stalled short of its setpoint it is jammed (2026-02-21: 6 stalls at -17 to -30°
      // with the setpoint 3–251° away). Parked at its -270° soft limit (TURRET_MIN_ANGLE, TurretSubsystem.java:55) it
      // pushes something a few degrees short of it: 15 stalls at -264 to -271°, setpoint -270°, up to 14.7 s at 53 A,
      // in 10 of the 170 practice logs of 2026-02-19..22.
      neverStalls: true,
      setpoint: {
        position: '/Shooter/Turret/PositionRotations', // a Rotation2d in turret radians
        setpoint: '/RealOutputs/Shooter/Turret/Setpoint',
        toDegrees: 180 / Math.PI,
        where: 'TurretSubsystem.java:55-56 (TURRET_MIN_ANGLE -270°, TURRET_MAX_ANGLE -12.7°)',
      },
    },
    {
      name: 'Intake rack',
      motors: [{
        name: 'Intake rack',
        canId: 14, // Robot.java:338
        supplyCurrent: '/Intake/Rack/SupplyCurrentAmps',
        statorCurrent: '/Intake/Rack/StatorCurrentAmps',
        connected: '/Intake/Rack/Connected',
        temperature: '/Intake/Rack/TemperatureC',
        updating: '/Intake/Rack/StatorCurrentAmps',
      }],
      limits: { supplyA: 40, supplyEnabled: true, statorA: 40, statorEnabled: true, where: 'LintakeSubsystem.java:212-215' },
    },
    {
      name: 'Intake rollers',
      motors: [rollerMotor('Intake rollers', '/Intake/Rollers', 8)], // Robot.java:339
      limits: { supplyA: 40, supplyEnabled: true, statorA: 55, statorEnabled: true, where: 'LintakeSubsystem.java:240-243' },
    },
    {
      name: 'Indexer',
      motors: [rollerMotor('Indexer', '/Indexer/Roller', 9)], // the spindexer's spinner, Robot.java:311
      limits: { supplyA: 40, supplyEnabled: true, supplyLowerA: 40, supplyLowerSeconds: 0.25, statorA: 80, statorEnabled: false, where: 'SpindexerSubsystem.java:123-128' },
    },
    {
      name: 'Kicker',
      motors: [rollerMotor('Kicker', '/Indexer/Kicker', 10)], // Robot.java:322
      limits: { supplyA: 40, supplyEnabled: true, supplyLowerA: 40, supplyLowerSeconds: 0.25, statorA: 80, statorEnabled: false, where: 'SpindexerSubsystem.java:149-154' },
    },
    {
      name: 'Climber',
      motors: [{
        name: 'Climber',
        canId: 16, // ClimberIO.java:51
        supplyCurrent: '/Climber/SupplyCurrentAmps',
        statorCurrent: '/Climber/StatorCurrentAmps',
        connected: '/Climber/Connected',
        temperature: '/Climber/TempC',
        updating: '/Climber/StatorCurrentAmps',
      }],
      limits: { supplyA: 40, supplyEnabled: true, statorA: 50, statorEnabled: true, where: 'ClimberIO.java:87-89 (built only up to b197f9a)' },
    },
  ],

  // `updating`: the gyro's yaw rate (longest gap at rest 3.0 s). The CANcoders and the CANrange have nothing that
  // changes at rest.
  otherDevices: [
    ...swerveModules.map((m) => ({ name: `${m} CANcoder`, connected: `/Swerve/${m} Module/CancoderConnected` })),
    { name: 'Turret CANcoder 24t', connected: '/Shooter/Turret Cancoder24t/Connected' },
    { name: 'Turret CANcoder 26t', connected: '/Shooter/Turret Cancoder26t/Connected' },
    { name: 'Intake CANrange', connected: '/Intake/CANRange/Connected' },
    { name: 'Gyro (Pigeon)', connected: '/Swerve/Gyro/IsConnected', updating: '/Swerve/Gyro/YawVelocityRadPerSec' },
  ],

  // Every device that reports its health, all on the one CANivore, so a drop of the whole bus is read as one event.
  canBuses: [{
    name: 'CANivore',
    members: [
      { name: 'Gyro (Pigeon)', key: '/Swerve/Gyro/IsConnected' },
      ...swerveModules.map((m) => ({ name: `${m} module`, key: `/RealOutputs/Module${m}refresh status code`, ok: 'OK' })),
      ...swerveModules.map((m) => ({ name: `${m} CANcoder`, key: `/Swerve/${m} Module/CancoderConnected` })),
      ...swerveModules.flatMap((m) => [
        { name: `${m} drive`, key: `/Swerve/${m} Module/DriveConnected` },
        { name: `${m} steer`, key: `/Swerve/${m} Module/TurnConnected` },
      ]),
      { name: 'Flywheel leader', key: '/Shooter/Flywheel/FlywheelLeaderConnected' },
      { name: 'Flywheel follower', key: '/Shooter/Flywheel/FlywheelFollowerConnected' },
      { name: 'Hood', key: '/Shooter/Hood/Connected' },
      { name: 'Turret', key: '/Shooter/Turret/Connected' },
      { name: 'Turret CANcoder 24t', key: '/Shooter/Turret Cancoder24t/Connected' },
      { name: 'Turret CANcoder 26t', key: '/Shooter/Turret Cancoder26t/Connected' },
      { name: 'Intake rack', key: '/Intake/Rack/Connected' },
      { name: 'Intake rollers', key: '/Intake/Rollers/Connected' },
      { name: 'Intake CANrange', key: '/Intake/CANRange/Connected' },
      { name: 'Indexer', key: '/Indexer/Roller/Connected' },
      { name: 'Kicker', key: '/Indexer/Kicker/Connected' },
      { name: 'Climber', key: '/Climber/Connected' },
    ],
  }],

  // Superstructure.java:36-50 (states), :73 (state), :95-108 (the drivers' buttons). Score and Feed Request are the
  // shot mode, not buttons, and the Auto requests come from autos, so neither counts.
  stateMachine: {
    name: 'Superstructure',
    state: '/RealOutputs/Superstructure/State',
    idle: ['IDLE'],
    waitsOnPurpose: ['PRE_CLIMB'],
    requests: ['Shoot Request', 'Intake Request', 'Anti Jam Req', 'Pre Climb Req', 'Climb Req'].map((r) => ({ name: r.replace(/ Req(uest)?$/, ' request'), key: `/RealOutputs/Superstructure/${r}` })),
    sensors: [
      { name: 'Intake CANrange detects', key: '/Intake/CANRange/IsDetected' },
      { name: 'Superstructure ready', key: '/RealOutputs/Superstructure/Ready?' },
      { name: 'Flywheel at speed', key: '/RealOutputs/Shooter/At Vel Setpoint?' },
      { name: 'Hood at setpoint', key: '/RealOutputs/Shooter/Hood/At Setpoint?' },
      { name: 'Turret at setpoint', key: '/RealOutputs/Shooter/Turret/At Setpoint?' },
    ],
  },

  // The what-if sliders cap this group's supply current per motor.
  whatIfGroup: 'Flywheel',
  // Assumed to be the same board as the 2026 offseason robot (a CTRE PDP 2.0, no current telemetry): these logs
  // have a 24-channel /PowerDistribution entry, but every channel and the total read 0 A in all 55.
  powerDistribution: 'ctre-pdp-2',

  // The hood zeroes on the driver's B button (Robot.java:615-621, with the intake and the climber): it drives down at
  // -3 V until the filtered stator current passes 30 A, then sets the hood to 23.16° and prints "Hood Zeroed"
  // (TurretSubsystem.java:325-330). Nothing zeroes it at boot. The intake rack and the climber zero the same way but
  // are linear (meters), which this list (degrees) can't hold.
  zeroing: [
    {
      mechanism: 'Hood',
      position: '/Shooter/Hood/HoodRotations', // mechanism rotations (SensorToMechanismRatio = HOOD_GEAR_RATIO)
      positionToDegrees: 360,
      doneMessage: /Hood Zeroed/,
      moveDegrees: 3,
      zeroDirection: 'down',
      // HOOD_MIN_ANGLE (TurretSubsystem.java:52). An unzeroed hood reads far from it: the 55 logs of 2026-02-21 start
      // at -1.3° or 1.85° (22 logs) or, zero kept through a code restart, at 23.7-23.9° (33), and nothing in between.
      stopDegrees: 23.16,
      zeroCurrent: {
        statorCurrent: '/Shooter/Hood/HoodStatorCurrentAmps',
        thresholdA: 30,
        statorLimitA: 80,
        where: 'TurretSubsystem.java:53 (HOOD_CURRENT_ZERO_THRESHOLD), stator limit TurretSubsystem.java:555',
      },
    },
  ],

  // The turret motor's position is a Rotation2d in turret radians (SensorToMechanismRatio = TURRET_GEAR_RATIO,
  // TurretIO.java:57); the code's turret angle from its two CANcoders is a Rotation2d too. Over 1-s moves of 0.2 to 3 rad,
  // the motor moved 0.96–1.02 times the absolute angle (median per log, the 17 logs of 2026-02-21 with 5 or more such
  // moves; none in the gear-off stretch): both in turret radians.
  slipChecks: [{
    mechanism: 'Turret',
    motor: '/Shooter/Turret/PositionRotations',
    motorToDegrees: 180 / Math.PI,
    absolute: '/RealOutputs/Shooter/Turret/Turret Calculated Rotation',
    absoluteToDegrees: 180 / Math.PI,
    where: 'TurretSubsystem.java:248 (getCalculatedTurretRotations, from the two turret CANcoders; it also seeds the motor at boot, :142-145)',
  }],

  // Camera.java:100 logs each camera under "Apriltag Vision/<name>"; :168 logs the pose the code took from it.
  // Names from R1WispSwerveConstants.java:63-106.
  cameras: ['Front_Left', 'Front_Right', 'Back_Left', 'Back_Right'].map((name) => ({
    name,
    acceptedPose: `/RealOutputs/Vision/${name}/Pose2d`,
    result: `/Apriltag Vision/${name}/Result`,
    stale: `/Apriltag Vision/${name}/Stale`,
    connected: `/Apriltag Vision/${name}/Connected`,
  })),

  foresight: {
    controllerNames: [0, 1].map((port) => `/DriverStation/Joystick${port}/Name`), // driver 0, operator 1 (Robot.java:194-195)
    gyroYaw: '/Swerve/Gyro/Yaw',
    zeroChecks: [
      // The turret motor is seeded at boot from the two CANcoders (TurretSubsystem constructor); the code logs that
      // angle every loop as /RealOutputs/Shooter/Turret/Turret Calculated Rotation. The motor's own position is logged
      // as a Rotation2d (radians), which this check reads as rotations, so it can't be compared yet.
      // mech/slip compares the same pair while the robot runs (slipChecks below).
      { mechanism: 'Turret', notCheckable: 'the turret motor\'s position is logged in radians (a Rotation2d), and this check reads motor positions in rotations' },
      { mechanism: 'Hood', notCheckable: 'the hood has no absolute encoder' },
    ],
    snapshot: {
      devices: [
        // An offset written as fromRotations(x).plus(k180deg) is applied as x + 0.5 wrapped into -0.5..0.5
        // (Rotation2d.getRotations()); R1WispSwerveConstants.java:290 applies it, :254 makes the steer motor read it.
        ...swerveModules.map((m, i) => ({
          name: `${m} CANcoder`,
          model: 'CANcoder' as const,
          canId: swerveCanIds[m].cancoder,
          magnetOffset: [-0.22656 + 0.5, -0.388, -0.3 + 0.5, 0.3303][i],
          readBy: swerveCanIds[m].steer,
          where: `R1WispSwerveConstants.java:${[175, 180, 186, 191][i]}`,
        })),
        // The turret CANcoders' offsets are left out: the code sets -1.1866 and -1.3269 rotations
        // (TurretSubsystem.java:178, 189), outside the -1..1 Phoenix accepts, so what the devices hold is unknown
        // until a snapshot reads it. No motor reads them as its feedback sensor.
        { name: 'Turret CANcoder 24t', model: 'CANcoder', canId: 5, where: 'Robot.java:374' },
        { name: 'Turret CANcoder 26t', model: 'CANcoder', canId: 4, where: 'Robot.java:377' },
        { name: 'Gyro (Pigeon)', model: 'Pigeon 2', canId: 0, where: 'R1WispSwerveConstants.java getGyroID()' },
      ],
      ratios: [
        // SDS Mk5n R1: 7.03 motor turns per wheel turn, 2 in wheel radius (SwerveConstants.java:111): motor rotations
        // per meter of travel.
        { group: 'Drive', sensorToMechanism: 7.03 / (2 * Math.PI * 0.0508), where: 'R1WispSwerveConstants.java:156 (gear ratio) and :221 (SensorToMechanismRatio)' },
        // Mk5n steer, fused with the CANcoder: the ratio is rotor-to-sensor, sensor-to-mechanism 1. The code writes
        // `return 287 / 11;` (int literals), which Java computes as 26, not 26.09: 26 is what the motors run.
        { group: 'Steer', rotorToSensor: 26, sensorToMechanism: 1, where: 'R1WispSwerveConstants.java:162 (gear ratio) and :255-256' },
        // (42/12)·(32/16)·(85/10) = 59.5 motor turns per turret turn.
        { group: 'Turret', sensorToMechanism: (42 / 12) * (32 / 16) * (85 / 10), where: 'TurretIO.java:21 (TURRET_GEAR_RATIO) and :57' },
      ],
    },
  },
}
