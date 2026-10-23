/**
 * Robot profiles for team 340's 2026 robot, read from two of their public match logs (NYRO Q18, March; DALY Q70,
 * May). A worked example of a robot that doesn't use AdvantageKit: its logs come from WPILib's DataLogManager and
 * its own telemetry, which publishes one `struct:TalonFX` per motor under NT:/Telemetry. Each struct carries
 * supplyCurrent, statorCurrent, deviceTemp, velocity (and more); the log's own schema says the layout, so a key is
 * the struct entry plus a field name (readers/wpilog.ts).
 *
 * Built from the logs alone, not the robot code:
 *  - No current limits: the code wasn't read, so power/limit-not-applied says "not checked" for every group.
 *  - No battery voltage or brownout flag in either log, so the battery rules can't run. Motor currents are summed
 *    for the main breaker's heating (power/main-breaker-margin), which needs no voltage.
 *  - Followers are published about 4 times a second, leaders 50 (measured on both logs while enabled): rules that
 *    read a follower say so on their findings.
 *  - The mechanisms changed between the two events, so each event has its own profile; the one whose motors are in
 *    a log fits it best and is chosen for it.
 */
import { DATALOGMANAGER_SIGNALS } from './datalogmanager.ts'
import type { Motor, MotorGroup, RobotProfile } from './types.ts'

const T = 'NT:/Telemetry'

/** A TalonFX struct published at `path` (the entry name ends in "/"; fields follow it). */
function talon(name: string, path: string): Motor {
  const entry = `${T}/${path}/`
  return {
    name,
    supplyCurrent: `${entry}supplyCurrent`,
    statorCurrent: `${entry}statorCurrent`,
    velocity: `${entry}velocity`,
    temperature: `${entry}deviceTemp`,
  }
}

/** Not read from 340's code: the limits rule says "not checked" rather than guess. */
const NOT_READ = { where: "not read from 340's robot code" }

const modules = ['frontLeft', 'frontRight', 'backLeft', 'backRight']

const swerve: MotorGroup[] = [
  { name: 'Drive', motors: modules.map((m) => talon(`${m} drive`, `swerve/api/hardware/${m}/moveMotor`)), limits: NOT_READ },
  { name: 'Steer', motors: modules.map((m) => talon(`${m} steer`, `swerve/api/hardware/${m}/turnMotor`)), limits: NOT_READ },
]

const base: Omit<RobotProfile, 'name' | 'code' | 'motorGroups' | 'whatIfGroup'> = {
  codebase: '',
  game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 },
  signals: {
    ...DATALOGMANAGER_SIGNALS,
    // PhotonVision's alerts, published by WPILib's Alerts.
    alertGroups: ['NT:/SmartDashboard/PhotonAlerts'],
    // Rotation2d, radians, like AdvantageKit's gyro keys.
    gyroPitch: `${T}/swerve/api/state/pitch`,
    gyroRoll: `${T}/swerve/api/state/roll`,
    odometryPose: `${T}/swerve/api/state/pose`,
  },
  battery: { id: [], idSource: [], gaugeValid: [], effectiveCapacityAh: [], ratedCapacityAh: [], remainingChargePct: [], numCycles: [] },
  // The same assumptions as any profile: nothing in the log measures them.
  power: { otherLoadsAmps: 3, restVoltageMin: 12.5, marginVolts: 1.0, healthyResistanceMaxOhms: 0.020 },
  otherDevices: [],
  zeroing: [],
  // PhotonVision results are logged as photonstruct bytes, which Hindsight doesn't decode yet.
  cameras: [],
}

export const frc340Nyro2026: RobotProfile = {
  ...base,
  name: "Team 340's 2026 robot (NYRO, March)",
  team: 340,
  code: { repo: 'unknown (profile read from a public log)', branch: 'unknown', sha: 'unknown' },
  motorGroups: [
    ...swerve,
    { name: 'Shooter port', sameLoop: true, motors: [talon('Shooter port lead', 'shooters/portLead'), talon('Shooter port follower', 'shooters/portFollow')], limits: NOT_READ },
    { name: 'Shooter starboard', sameLoop: true, motors: [talon('Shooter starboard lead', 'shooters/starboardLead'), talon('Shooter starboard follower', 'shooters/starboardFollow')], limits: NOT_READ },
    { name: 'Hood', motors: [talon('Hood', 'hood/motor')], limits: NOT_READ },
    { name: 'Indexer', motors: [talon('Twindexer', 'indexer/twindexer'), talon('Uptake', 'indexer/uptake')], limits: NOT_READ },
    { name: 'Intake pivot', motors: [talon('Intake pivot', 'intake/pivot')], limits: NOT_READ },
    { name: 'Intake rollers', motors: [talon('Intake rollers', 'intake/rollers')], limits: NOT_READ },
    { name: 'Climber', sameLoop: true, motors: [talon('Climber lead', 'climber/lead'), talon('Climber follower', 'climber/follow')], limits: NOT_READ },
  ],
  whatIfGroup: 'Shooter port',
}

export const frc340Daly2026: RobotProfile = {
  ...base,
  name: "Team 340's 2026 robot (DALY, May)",
  team: 340,
  code: { repo: 'unknown (profile read from a public log)', branch: 'unknown', sha: 'unknown' },
  motorGroups: [
    ...swerve,
    {
      name: 'Shooter',
      sameLoop: true,
      motors: [
        talon('Shooter port lower lead', 'shooter/portLowerLead'),
        talon('Shooter port upper follower', 'shooter/portUpperFollow'),
        talon('Shooter starboard lower follower', 'shooter/starboardLowerFollow'),
        talon('Shooter starboard upper follower', 'shooter/starboardUpperFollow'),
      ],
      limits: NOT_READ,
    },
    { name: 'Hood', motors: [talon('Hood', 'hood/motor')], limits: NOT_READ },
    { name: 'Indexer port', sameLoop: true, motors: [talon('Indexer port upper lead', 'indexer/portUpperLead'), talon('Indexer port lower follower', 'indexer/portLowerFollow')], limits: NOT_READ },
    { name: 'Indexer starboard', sameLoop: true, motors: [talon('Indexer starboard lower lead', 'indexer/starboardLowerLead'), talon('Indexer starboard upper follower', 'indexer/starboardUpperFollow')], limits: NOT_READ },
    { name: 'Intake pivot', motors: [talon('Intake pivot', 'intake/pivot')], limits: NOT_READ },
    { name: 'Intake rollers', sameLoop: true, motors: [talon('Intake rollers lead', 'intake/rollersLead'), talon('Intake rollers follower', 'intake/rollersFollow')], limits: NOT_READ },
  ],
  whatIfGroup: 'Shooter',
}
