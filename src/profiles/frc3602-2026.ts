/**
 * Robot profile for team 3602's 2026 robot, read from one of their public match logs (MICMP2 Q3, April). A worked
 * example of the thinnest useful log: WPILib's DataLogManager plus the values the team publishes for its Elastic
 * dashboard under NT:/Elastic.
 *
 * Built from the log alone, not the robot code:
 *  - Battery voltage comes from the dashboard value, logged about 17 times a second while enabled (a robot loop logs
 *    50): findings that read it say a short dip can fall between samples.
 *  - No per-motor supply currents. The two spindexer currents on the dashboard are left out on purpose: summing two
 *    of the robot's motors would make the battery model and the main breaker's heating look far too light.
 *  - No gyro pitch or roll, no brownout flag or setting, no loop time.
 */
import { DATALOGMANAGER_SIGNALS } from './datalogmanager.ts'
import type { RobotProfile } from './types.ts'

export const frc3602_2026: RobotProfile = {
  name: "Team 3602's 2026 robot",
  codebase: '',
  code: { repo: 'unknown (profile read from a public log)', branch: 'unknown', sha: 'unknown' },
  game: { name: '2026 REBUILT', autoSeconds: 20, teleopSeconds: 140 },
  signals: {
    ...DATALOGMANAGER_SIGNALS,
    batteryVoltage: 'NT:/Elastic/Status/BatteryVoltage',
    odometryPose: 'NT:/Elastic/Drive/Pose',
    alertGroups: ['NT:/SmartDashboard/Alerts'],
  },
  battery: { id: [], idSource: [], gaugeValid: [], effectiveCapacityAh: [], ratedCapacityAh: [], remainingChargePct: [], numCycles: [] },
  power: { otherLoadsAmps: 3, restVoltageMin: 12.5, marginVolts: 1.0, healthyResistanceMaxOhms: 0.020 },
  motorGroups: [],
  otherDevices: [],
  whatIfGroup: '',
  zeroing: [],
  cameras: [],
}
