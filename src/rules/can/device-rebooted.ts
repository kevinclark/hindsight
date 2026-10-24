/**
 * Did a CTRE device reboot while the robot was enabled?
 *
 * Checks: each device the robot code watches with the Hindsight companion (HindsightDevices.watch): its reboot count
 * (/Hindsight/Devices/<bus>/<model>/<id>/Resets) going up while enabled (in Foresight, the live pit check: while
 * disabled since start-up settled), and the lowest battery voltage in the 1.5 s before (the companion reads each
 * device once a second, so the reboot happened up to 1.5 s before the count went up).
 * A reboot longer than about a second shows as "not answering" instead (can/device-dropout); a count that rose at a
 * read where the device wasn't answering is left to that drop too.
 * Why: a device that reboots mid-match stops driving its mechanism until it is back, and the robot code is not told.
 * Phoenix keeps the flag (hasResetOccurred) but nothing logged it until the companion did. No log of ours has these
 * keys yet: the rule has never fired on a real robot.
 */
import { plural, round, rule, voltageList, type Problem } from '../rule.ts'
import { CTRE_PARENT_DEVICE_API, CTRE_TALONFX_API } from '../sources.ts'
import type { MatchView, WatchedDeviceView } from '../view.ts'
import { DEVICE_LATE_SECONDS, DEVICE_READ_SECONDS } from '../../match/companion.ts'
import { LOW_VOLTS, watched } from './bus.ts'

export default rule({
  id: 'can/device-rebooted',
  title: 'Device rebooted',
  severity: 'error',
  who: ['pit'],
  meaning: 'A motor controller or sensor restarted while the robot was enabled. Until it was back it did nothing, and it may have come back without the position it had.',
  causes: [
    { id: 'battery-sag', cause: 'The battery sagged so low that the device lost power', look: 'Power tab: battery voltage at each reboot; the power/brownout and power/margin findings' },
    { id: 'shared-power', cause: 'Power shared by several devices (a breaker, a PDH channel, a power splice)', look: 'which other devices rebooted at the same moment, and what power they share' },
    { id: 'device-power', cause: 'The device\'s own power connector, wire or breaker', look: 'wiggle the power connector and wire at that device; its breaker and PDH channel' },
    { id: 'device-fault', cause: 'The device itself (a firmware fault, damage)', look: 'Phoenix Tuner X: the device\'s sticky faults (Boot During Enable confirms the reboot) and firmware version' },
  ],
  nextStep: 'Wiggle-test the power connector and wire at that device, and check its breaker or PDH channel.',
  incident: 'Hindsight companion library (2026-10-20): it logs Phoenix\'s reboot flag; nothing logged it before',
  sources: [
    { ...CTRE_PARENT_DEVICE_API, says: 'HasResetOccurred returns true if the device has reset since the previous call; GetResetOccurredChecker returns a lambda that checks for resets.' },
    { ...CTRE_TALONFX_API, says: 'The BootDuringEnable fault is "Device boot while detecting the enable signal", and it has a sticky version.' },
  ],
  thresholds: [
    { name: 'battery voltage that points at the power path', value: 'under 7 V', basis: 'judgment', how: 'The same line as can/device-dropout.' },
    { name: 'voltage read before each reboot', value: 'the lowest in the 1.5 s before', basis: 'judgment', how: 'The companion reads each device once a second, so the reboot happened up to 1.5 s before the count rose.' },
  ],
  forEach: 'watchedDevice',

  check(device, match) {
    // A count that rose at a read where the device wasn't answering belongs to that drop (can/device-dropout).
    const reboots = device.resets().increases(watched(match)).filter((t) => device.connected().at(t) >= 0.5)
    if (reboots.length === 0) return
    return rebootProblem(device, reboots, match)
  },
})

/** The finding for a device's reboots. */
function rebootProblem(device: WatchedDeviceView, reboots: number[], match: MatchView): Problem {
  const battery = match.signalIfLogged('batteryVoltage')
  const voltages = reboots.map((t) => battery?.lowest(match.before(t, DEVICE_LATE_SECONDS)).value ?? NaN)
  const known = voltages.filter((v) => !Number.isNaN(v))
  const allLow = known.length > 0 && known.every((v) => v < LOW_VOLTS)
  const noneLow = known.length === reboots.length && known.every((v) => v >= LOW_VOLTS + 0.5)
  const together = devicesRebootedWith(match, device.name, reboots)

  const likely: string[] = []
  const ruledOut: Record<string, string> = {}
  if (allLow) likely.push('battery-sag')
  if (noneLow) ruledOut['battery-sag'] = `the battery stayed above ${LOW_VOLTS + 0.5} V before every reboot`
  if (together.length) {
    likely.push('shared-power')
    ruledOut['device-fault'] = `${plural(together.length, 'other device')} rebooted at the same moment`
  } else if (!allLow) {
    likely.push('device-power')
  }

  return {
    message: `${device.name} rebooted ${plural(reboots.length, 'time')}, first ${match.whenAt(reboots[0])}`,
    at: reboots[0],
    evidence: {
      reboots: reboots.length,
      'lowest battery voltage in the 1.5 s before each reboot (V)': voltageList(voltages),
      'other devices rebooted at the same moment': together.length ? together.join(', ') : 'none',
      'reboots since the robot code started': round(device.resets().last(), 0),
    },
    likely, ruledOut,
    measured: [{ label: 'reboots', value: reboots.length, unit: '' }],
    plot: battery ? {
      signals: [battery], unit: 'V', from: reboots[0] - 3, to: reboots[reboots.length - 1] + 2,
      marks: reboots, line: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
    } : undefined,
  }
}

/**
 * The other watched devices whose reboot count went up in the same companion read as one of these, or the next. The
 * companion logs every device's keys together, so each has a Resets key.
 */
function devicesRebootedWith(match: MatchView, except: string, reboots: number[]): string[] {
  const sameMoment = (t: number) => reboots.some((r) => Math.abs(t - r) <= DEVICE_READ_SECONDS)
  return match.watchedDevices()
    .filter((d) => d.name !== except && d.resets().increases(watched(match)).some(sameMoment))
    .map((d) => d.name)
}
