/**
 * Where a DogLog log keeps the roboRIO's own readings.
 *
 * DogLog (a logging library some teams use instead of AdvantageKit) writes through WPILib's DataLogManager, so the
 * Driver Station state and the wall clock are where datalogmanager.ts says. In the logs below (its logExtras option
 * on) it also logged the roboRIO's readings under /Robot/SystemStats (battery voltage, brownout flag, rails, CAN bus)
 * and the power distribution board under /Robot/SystemStats/PowerDistribution.
 *
 * Read from team 334's public 2026 logs (DogLog with logExtras=true, captureDs=true, captureNt=false):
 *  - /Robot/SystemStats/EpochTimeMicros is the roboRIO's FPGA clock (24.6 s at log time 24.6 s), not the wall clock,
 *    so the wall clock stays DataLogManager's systemTime: that is what lines a Driver Station log up with the match.
 *  - With captureNt off there is no NT:/FMSInfo, so these logs don't say which match they hold.
 *  - While enabled, BatteryVoltage is logged 50 times a second and the board's TotalCurrent about 12 (every 80 ms).
 */
import { DATALOGMANAGER_SIGNALS } from './datalogmanager.ts'
import type { RobotProfile } from './types.ts'

const STATS = '/Robot/SystemStats'

/** The power distribution board's folder: ChannelCurrent, TotalCurrent, Voltage, ChannelCount. */
export const DOGLOG_POWER_DISTRIBUTION = `${STATS}/PowerDistribution`

export const DOGLOG_SIGNALS: RobotProfile['signals'] = {
  ...DATALOGMANAGER_SIGNALS,
  batteryVoltage: `${STATS}/BatteryVoltage`,
  brownedOut: `${STATS}/BrownedOut`,
  brownoutVoltage: `${STATS}/BrownoutVoltage`,
  systemActive: `${STATS}/SystemActive`,
}
