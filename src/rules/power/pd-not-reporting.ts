/**
 * Is the power distribution board reporting its channel currents to the robot code?
 *
 * Checks: the board's channel currents, voltage and channel count (the powerDistribution* signals), against the
 * board the robot profile says is on the robot. A REV PDH and a CTRE PDP (v1) report each channel's current over
 * CAN; a CTRE PDP 2.0 has no current telemetry at all.
 * Fires when the motors drew current but the board's channel currents were logged only once or twice, or were all
 * zero, or its voltage read 1 V or less: a warning when the board could report, context (grey) when it can't or the
 * profile doesn't say which board it is.
 * Why: per-channel current is the only way to see each breaker's real load, including loads that aren't motor
 * controllers. Without it, Hindsight adds up the motor controllers' own supply currents instead.
 */
import { maxOf, round, rule } from '../rule.ts'
import { REV_PDH_SPECS, WPILIB_CONTROL_SYSTEM_HARDWARE, WPILIB_POWER_DISTRIBUTION } from '../sources.ts'
import type { MatchView } from '../view.ts'

const MOTORS_DRAWING_AMPS = 20 // total motor current that the board's channels must show if it is reporting
// The channel count the log claims tells which type of board the code's reader was set up for.
const CLAIMED: Record<number, string> = { 24: 'a REV Power Distribution Hub (24 channels)', 16: 'a CTRE Power Distribution Panel (16 channels)' }
const BOARD: Record<string, string> = { 'rev-pdh': 'a REV PDH', 'ctre-pdp': 'a CTRE PDP', 'ctre-pdp-2': 'a CTRE PDP 2.0' }

export default rule({
  id: 'power/pd-not-reporting',
  title: 'Power distribution board not reporting',
  severity: 'warning',
  who: ['software', 'pit'],
  meaning: 'The robot code got no channel currents from the power distribution board, so nobody can see how hard each breaker is working, including the loads that aren\'t motor controllers. Hindsight adds up the motor controllers\' supply currents instead.',
  causes: [
    { id: 'cannot-report', cause: 'The board can\'t report: a CTRE PDP 2.0 has no current telemetry', look: 'the board on the robot: if it is a PDP 2.0 there is nothing to fix; each breaker\'s load is only what its motor controller reports' },
    { id: 'wrong-type', cause: 'The code reads the wrong type of board (a REV PDH when the robot has a CTRE PDP, or the other way round)', look: 'the board on the robot against the code that creates the power distribution logger (its module type: kRev or kCTRE); the channel count in this finding says which type the code read' },
    { id: 'wrong-id', cause: 'The code asks for a different CAN ID than the board has', look: 'the board\'s CAN ID in Phoenix Tuner X or the REV Hardware Client (a PDP defaults to 0, a PDH to 1) against the ID in the code' },
    { id: 'can', cause: 'The board isn\'t on the CAN bus (loose CAN wires at the board, or the bus ends before it)', look: 'the CAN wires at the board, and whether the board shows in Phoenix Tuner X or the REV Hardware Client' },
  ],
  nextStep: 'First check which board the robot has: a CTRE PDP 2.0 can\'t report. For a REV PDH or a CTRE PDP, check the code asks for that type and the board\'s CAN ID.',
  incident: 'Two robots\' logs had two records of 24 channels, all 0 A, while the robot drew hundreds of amps.',
  sources: [
    { ...WPILIB_POWER_DISTRIBUTION, says: 'PowerDistribution auto-detects a board only at CAN ID 0 (CTRE) or 1 (REV); per-channel current is read on PDP channels 0 to 15 or PDH channels 0 to 23.' },
    { ...WPILIB_CONTROL_SYSTEM_HARDWARE, says: 'The PDP 2.0 has no built-in current logging; the original PDP has a CAN interface for logging current, temperature and battery voltage.' },
    { ...REV_PDH_SPECS, says: 'The PDH measures each high-current channel from 0 to 127.9 A in 125 mA steps, and each low-current channel from 0 to 31.94 A.' },
  ],
  thresholds: [
    { name: 'motor current the channels must show if reporting', value: '20 A in total', basis: 'judgment', how: 'Chosen.' },
    { name: 'board voltage that means silent', value: '1 V or less', basis: 'judgment', how: 'Chosen.' },
  ],

  check(match) {
    const channels = match.lists('powerDistributionCurrents')
    // The board's own total can't show the board is silent: only the motors' currents can.
    const power = match.powerIfLogged()
    const motorPeak = power?.grid.motors.length ? maxOf(power.grid.amps) : NaN
    if (!(motorPeak > MOTORS_DRAWING_AMPS)) return match.couldNotCheck('no motor current to compare with')

    const highestChannel = highestCurrent(channels.v)
    const boardVolts = match.signalIfLogged('powerDistributionVoltage')?.highest().value ?? NaN
    const count = match.signalIfLogged('powerDistributionChannels')?.last() ?? (channels.v[0]?.length ?? 0)
    const silent = channels.t.length <= 2 || highestChannel < 0.5 || (Number.isFinite(boardVolts) && boardVolts <= 1)
    if (!silent) return

    const claimed = CLAIMED[count] ?? `a board with ${count} channels`
    const board = boardOf(match, count)
    const boardSource = match.profile.powerDistribution ? ' (robot profile)' : ' (the log claims 16 channels)'
    const evidence = {
      'board on the robot': board ? `${BOARD[board]}${boardSource}` : 'unknown',
      'the log claims': claimed,
      'channel-current records': channels.t.length,
      'highest channel current (A)': round(highestChannel, 1),
      'board voltage, highest (V)': Number.isFinite(boardVolts) ? round(boardVolts, 1) : 'not logged',
      'motors drew, total, peak (A)': round(motorPeak, 0),
    }

    if (board === 'ctre-pdp-2') {
      return {
        message: `The power board (a CTRE PDP 2.0) doesn't report per-channel current; Hindsight adds up the motor controllers' supply currents instead (plus an assumed ${match.profile.power.otherLoadsAmps} A for everything else)`,
        severity: 'info',
        evidence,
        likely: ['cannot-report'],
        nextStep: 'Nothing to fix on the board. To see a non-motor load, log its current another way, or move to a board that reports (a REV PDH).',
      }
    }

    const message = `The power distribution board reported nothing while the motors drew up to ${round(motorPeak, 0)} A (the log claims ${claimed})`
    if (board === 'rev-pdh' || board === 'ctre-pdp') {
      return {
        message,
        evidence,
        ruledOut: { 'cannot-report': `the robot has ${BOARD[board]}, which reports over CAN` },
        nextStep: `The robot has ${BOARD[board]} and the log claims ${claimed}: check the code asks for that type (not automatic detection) and that the board's CAN ID matches the code.`,
      }
    }
    // The profile doesn't say which board it is, so it may be one that can't report: context only.
    return {
      message,
      severity: 'info',
      evidence,
      nextStep: `First check which board the robot has (then name it in the robot profile): a CTRE PDP 2.0 can't report. For a REV PDH or a CTRE PDP, the log claims ${claimed}: check the code asks for that type and the board's CAN ID.`,
    }
  },
})

/** The highest current any channel reported in any record (0 if none is a number). */
function highestCurrent(records: number[][]): number {
  let highest = 0
  for (const record of records) highest = Math.max(highest, maxOf(record.filter(Number.isFinite)) || 0)
  return highest
}

/** Which board the robot has, or undefined when that isn't known. */
function boardOf(match: MatchView, channelCount: number) {
  // A profile that doesn't fit this log may name another robot's board: then the board is unknown. A log claiming
  // 16 channels means the code built a CTRE PDP (v1) reader, a board that reports; 24 is also what automatic
  // detection falls back to, so it says nothing about the board.
  let board = match.profile.powerDistribution
  if (!board && channelCount === 16) board = 'ctre-pdp'
  return match.profileFits ? board : undefined
}
