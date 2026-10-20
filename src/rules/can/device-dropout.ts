/**
 * Did a motor controller or sensor drop off CAN while enabled?
 *
 * Checks: each device's Connected flag going false while the robot was enabled (in Foresight, the live pit check:
 * while disabled since start-up settled), and the lowest battery voltage in
 * the 0.5 s before. A drop at low voltage points at the power path (the device browned out); a drop at normal
 * voltage points at CAN wiring or a connector.
 * Why: CalGames 2026 P0: flywheel follower 16 alone dropped off CAN 7 times, each at 5.85–6.31 V.
 *
 * Drops that took the whole bus down at once are left to can/bus-dropout.
 */
import { isFalse, plural, round, rule, type Problem } from '../rule.ts'
import type { DeviceView, Episode, MatchView } from '../view.ts'
import { busOf, isBusWide, LOW_VOLTS, plotDrops, readDrops, secondsWatched, watched, windowStart } from './bus.ts'


export default rule({
  id: 'can/device-dropout',
  title: 'Device dropped off CAN',
  severity: 'error',
  who: ['pit'],
  meaning: 'A motor controller or sensor stopped answering on the CAN bus while the robot was enabled. If it is a motor, it stopped working until it came back.',
  causes: [
    { id: 'battery-sag', cause: 'The battery sagged so low that the device lost power (voltage under about 7 V)', look: 'Power tab: battery voltage at each drop; the power/brownout and power/margin findings' },
    { id: 'shared-wiring', cause: 'Wiring or power shared by several devices (a CAN splice, a shared power breaker or channel)', look: 'which other devices dropped at the same moment, and what they share: the same CAN branch, the same PDH channel' },
    { id: 'can-connector', cause: 'A loose or damaged CAN connector or wire on that device\'s branch', look: 'tug the CAN wires at that device and at the ones either side of it; look for pinched or cracked wire' },
    { id: 'device-power', cause: 'The device\'s own power connector, wire or breaker', look: 'wiggle the power connector and wire at that device; its breaker and PDH channel' },
    { id: 'terminator', cause: 'A missing or loose terminating resistor at an end of the CAN chain', look: 'the far end of the CAN chain: the PDH/PDP termination jumper or a 120 Ω resistor on the last device (the roboRIO end is built in)' },
    { id: 'device-fault', cause: 'The device itself (old firmware, damage)', look: 'its status light during a dropout; the vendor tool (Phoenix Tuner, REV Hardware Client) for firmware and faults' },
  ],
  nextStep: 'Tug-test the CAN connectors on that device and the ones next to it, and check the CAN termination at the far end of the chain.',
  incident: 'CalGames 2026 P0: flywheel follower 16 off CAN 7 times at 5.85–6.31 V (P0 analysis); #in-hindsight: ≥ 11 CAN dropout episodes',
  forEach: 'device',

  check(device, match) {
    // `touching` keeps a drop that spans the auto→teleop gap as one drop.
    const drops = device.connected().episodes(isFalse, { touching: watched(match) })
    if (drops.length === 0) return
    // Drops that took the whole bus down are can/bus-dropout's.
    const bus = busOf(match, device.name)
    const own = drops.filter((d) => !isBusWide(bus, d))
    if (own.length === 0) return
    return deviceProblem(device, own, match)
  },
})

/** The finding for one device's own drops (not part of a whole-bus drop). */
function deviceProblem(device: DeviceView, drops: Episode[], match: MatchView): Problem {
  const battery = match.signal('batteryVoltage')
  // A drop already under way when the watched window began is timed from that start. It says nothing about sag.
  const { timed, alreadyOff, voltages, text: voltageText, everyDrop } = readDrops(match, battery, drops)
  const first = timed[0]
  const firstWhen = alreadyOff[0]
    ? `already off when ${windowStart(match)} ${match.whenAt(first.start)}`
    : match.whenAt(first.start)
  const secondsMissing = drops.reduce((sum, d) => sum + secondsWatched(match, d), 0)
  const lowOnes = voltages.filter((v) => v < LOW_VOLTS).length
  const allLow = voltages.length > 0 && lowOnes === voltages.length
  const closeCall = voltages.some((v) => Math.abs(v - LOW_VOLTS) < 0.5)
  // No battery voltage logged just before a drop that began while enabled.
  const unknownVolts = voltages.some((v) => Number.isNaN(v))
  const cameBack = timed[timed.length - 1].end >= match.logEnd ? 'no, still off at the end of the log' : 'yes'
  const others = otherDevices(match, device.name)
  const together = devicesDroppedWith(others, drops)

  const likely: string[] = []
  const ruledOut: Record<string, string> = {}
  if (allLow) {
    likely.push('battery-sag')
  } else if (voltages.length > 0 && lowOnes === 0 && !closeCall && !unknownVolts) {
    ruledOut['battery-sag'] = `the battery stayed above 7 V ${everyDrop}`
  }
  if (together.length) {
    likely.push('shared-wiring')
    ruledOut['device-fault'] = `${plural(together.length, 'other device')} dropped at the same moment`
  } else if (others.length) {
    ruledOut['shared-wiring'] = 'no other device dropped at the same moment'
    likely.push(allLow ? 'device-power' : 'can-connector')
  }

  return {
    message: `${device.name} dropped off CAN ${plural(drops.length, 'time')}, first ${firstWhen}`,
    at: first.start,
    evidence: {
      drops: drops.length,
      'seconds missing while enabled': round(secondsMissing),
      'came back': cameBack,
      'lowest battery voltage in the 0.5 s before each drop (V)': voltageText.join(', '),
      'other devices dropped at the same moment': othersDropped(together, others.length),
    },
    likely, ruledOut, nextStep: dropNextStep(allLow, everyDrop, together),
    measured: [{ label: 'drops off CAN', value: drops.length, unit: '' }],
    plot: plotDrops(battery, timed, 3, drops[drops.length - 1].end + 2),
  }
}

/** When each other device dropped off CAN while enabled (every motor with a Connected flag, and the other devices). */
function otherDevices(match: MatchView, except: string) {
  return match.connectedDevices()
    .filter((d) => d.name !== except && match.has(d.key))
    .map((d) => {
      const episodes = match.signal(d.key).episodes(isFalse, { touching: watched(match) })
      return { name: d.name, drops: episodes.map((e) => e.start) }
    })
}

/**
 * Names of the other devices that dropped within 1 s of any of these drops: a shared cause (power or the CAN trunk).
 * Strictly under 1 s here, while dropAround counts exactly TOGETHER_SECONDS apart as together: kept as it was.
 */
function devicesDroppedWith(others: { name: string; drops: number[] }[], drops: Episode[]): string[] {
  return others
    .filter((o) => o.drops.some((t) => drops.some((own) => Math.abs(t - own.start) < 1)))
    .map((o) => o.name)
}

/** The next step when the battery was low at every drop, or other devices dropped with this one. */
function dropNextStep(allLow: boolean, everyDrop: string, together: string[]): string | undefined {
  if (allLow) return `The battery was low ${everyDrop}: fix the voltage sag first (Power tab), then wiggle-test the power connector on that device.`
  if (together.length) return `${together.join(', ')} dropped at the same moment: check what they share (the same CAN branch or splice, the same power channel).`
  return undefined
}

/** Which other devices dropped at the same moment, for the evidence. */
function othersDropped(together: string[], otherCount: number): string {
  if (together.length) return together.join(', ')
  return otherCount ? 'none' : 'not checked (no other devices)'
}

