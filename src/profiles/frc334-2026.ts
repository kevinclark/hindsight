/**
 * Robot profile for team 334's 2026 robot, read from three of their public match logs (NYN2 Q26, E3 and E6, April).
 * A worked example of a DogLog log (doglog.ts): the roboRIO's readings and a REV PDH under /Robot/SystemStats.
 *
 * Built from the logs alone, not the robot code:
 *  - No per-motor currents (the Talon FX signals are in the team's .hoot files, which Hindsight doesn't read), so the
 *    robot's current is the PDH's own total. It is logged about 12 times a second while enabled, against 50 for the
 *    battery voltage, and about 0.1 s late (src/power/battery-model.ts, measuredTotal): findings that pair the two say
 *    it is logged slowly.
 *  - No gyro pitch or roll, and the loop time is in seconds (Hindsight's loop rule reads milliseconds): left out.
 */
import { DOGLOG_POWER_DISTRIBUTION, DOGLOG_SIGNALS } from './doglog.ts'
import type { RobotProfile } from './types.ts'

export const frc334_2026: RobotProfile = {
  name: "Team 334's 2026 robot",
  codebase: '',
  code: { repo: 'unknown (profile read from a public log)', branch: 'unknown', sha: 'unknown' },
  game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 },
  signals: {
    ...DOGLOG_SIGNALS,
    odometryPose: '/Robot/Swerve/Pose',
  },
  battery: { id: [], idSource: [], gaugeValid: [], effectiveCapacityAh: [], ratedCapacityAh: [], remainingChargePct: [], numCycles: [] },
  power: {
    otherLoadsAmps: 3, restVoltageMin: 12.5, marginVolts: 1.0, healthyResistanceMaxOhms: 0.020,
    totalCurrent: `${DOGLOG_POWER_DISTRIBUTION}/TotalCurrent`,
  },
  powerDistribution: 'rev-pdh',
  powerDistributionFolder: DOGLOG_POWER_DISTRIBUTION,
  motorGroups: [],
  otherDevices: [],
  whatIfGroup: '',
  zeroing: [],
  cameras: [],
}
