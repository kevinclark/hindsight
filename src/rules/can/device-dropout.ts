/**
 * Did a motor controller or sensor drop off CAN while enabled?
 *
 * Checks: each device's Connected flag going false while the robot was enabled (in Foresight, the live pit check:
 * while disabled since start-up settled), and the lowest battery voltage in
 * the 0.5 s before. A drop at low voltage points at the power path (the device browned out); a drop at normal
 * voltage points at CAN wiring or a connector.
 * Why: One 2026 match: flywheel follower 16 alone dropped off CAN 7 times, each at 5.85–6.31 V.
 *
 * Drops that took the whole bus down at once are left to can/bus-dropout.
 *
 * Devices the robot code watches with the Hindsight companion (HindsightDevices.watch) are checked too, from the
 * companion's Connected flag, when the profile has no Connected flag of its own for them (same model and CAN ID).
 * The companion reads once a second, so a drop shorter than about a second may not show, and the battery is read
 * over the 1.5 s before. No log of ours has the companion's keys yet.
 */
import { isFalse, plural, round, rule, type Problem } from '../rule.ts'
import { CTRE_CAN_TROUBLESHOOTING, WPILIB_PREEMPTIVE } from '../sources.ts'
import type { DeviceView, Episode, MatchView, WatchedDeviceView } from '../view.ts'
import { busOf, DROP_LOOK_BACK, isBusWide, LOW_VOLTS, plotDrops, readDrops, secondsWatched, watched, windowStart } from './bus.ts'
import { DEVICE_LATE_SECONDS, DEVICE_READ_SECONDS } from '../../match/companion.ts'


export default rule({
  id: 'can/device-dropout',
  title: 'Device dropped off CAN',
  severity: 'error',
  judges: 'fault',
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
  incident: 'One 2026 match: flywheel follower 16 off CAN 7 times at 5.85–6.31 V (the match analysis); #in-hindsight: ≥ 11 CAN dropout episodes',
  sources: [
    { ...CTRE_CAN_TROUBLESHOOTING, says: 'Bad crimps and connection points are the most common cause of intermittent connection issues; tug-test each crimped wire and jostle the CAN wiring to reproduce the red LED blips.' },
    { ...WPILIB_PREEMPTIVE, says: 'Tug-test the power connectors in the pit (none should pull out) and wiggle the battery connector; it is better for the robot to fail in the pits than in a match.' },
  ],
  thresholds: [
    { name: 'battery voltage that points at the power path', value: 'under 7 V', basis: 'judgment', how: 'Chosen, just above the 6.75 V roboRIO 2 default brownout level; the one case seen dropped at 5.85 to 6.31 V.' },
    { name: 'voltage read before each drop', value: 'the lowest in the 0.5 s before', basis: 'judgment', how: 'A Connected flag goes false about this long after the device stops answering (Phoenix\'s isConnected).' },
  ],
  forEach: 'device',

  check(device, match) {
    // `touching` keeps a drop that spans the auto→teleop gap as one drop.
    const drops = device.connected().episodes(isFalse, { touching: watched(match) })
    if (drops.length === 0) return
    // Drops that took the whole bus down are can/bus-dropout's.
    const bus = busOf(match, device.name)
    const own = drops.filter((d) => !isBusWide(bus, d))
    if (own.length === 0) return
    // A companion reading in simulation or replay, or one that failed, says nothing about the device.
    const unread = device.watched ? unreadStatus(device.watched, own) : null
    if (unread) return match.couldNotCheck(`the Hindsight companion didn't read it (${unread})`)
    return deviceProblem(device, own, match)
  },
})

/** The finding for one device's own drops (not part of a whole-bus drop). */
function deviceProblem(device: DeviceView, drops: Episode[], match: MatchView): Problem {
  const battery = match.signal('batteryVoltage')
  // A drop already under way when the watched window began is timed from that start. It says nothing about sag.
  // A device only the companion watches is read once a second, so its drop began up to 1.5 s before the flag fell.
  const lookBack = device.watched ? DEVICE_LATE_SECONDS : DROP_LOOK_BACK
  const { timed, alreadyOff, voltages, text: voltageText, everyDrop } = readDrops(match, battery, drops, lookBack)
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
  const together = devicesDroppedWith(others, drops, !!device.watched)

  const likely: string[] = []
  const ruledOut: Record<string, string> = {}
  if (allLow) {
    likely.push('battery-sag')
  } else if (voltages.length > 0 && lowOnes === 0 && !closeCall && !unknownVolts) {
    ruledOut['battery-sag'] = `the battery stayed above 7 V ${everyDrop}`
  }
  // A companion reading that never once answered may be status signals turned off, not a device off the bus.
  const neverAnswered = !!device.watched && device.connected().highest().value < 0.5
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
      [`lowest battery voltage in the ${lookBack} s before each drop (V)`]: voltageText.join(', '),
      'read by': device.watched ? 'the Hindsight companion (HindsightDevices.watch), once a second' : undefined,
      'other devices dropped at the same moment': othersDropped(together, others.length),
    },
    likely, ruledOut, nextStep: neverAnswered ? NEVER_ANSWERED : dropNextStep(allLow, everyDrop, together),
    measured: [{ label: 'drops off CAN', value: drops.length, unit: '' }],
    plot: plotDrops(battery, timed, 3, drops[drops.length - 1].end + 2),
  }
}

const NEVER_ANSWERED = 'It never answered the Hindsight companion in this log. If Phoenix Tuner X shows it on the bus, the robot code has turned its status signals off (optimizeBusUtilization), so the companion can\'t read it; if not, check its power and CAN wiring.'

/** The companion's status at the drops when it never read the device then ("not read", "unavailable: ..."), or null. */
function unreadStatus(device: WatchedDeviceView, drops: Episode[]): string | null {
  const statuses = drops.map((d) => device.status().at(d.start))
  return statuses.every((s) => s === 'not read' || s.startsWith('unavailable')) ? statuses[0] : null
}

/** When each other device dropped off CAN while enabled (every motor with a Connected flag, and the other devices). */
function otherDevices(match: MatchView, except: string) {
  return match.connectedDevices()
    .filter((d) => d.name !== except && match.has(d.key))
    .map((d) => {
      const episodes = match.signal(d.key).episodes(isFalse, { touching: watched(match) })
      return { name: d.name, drops: episodes.map((e) => e.start), watched: !!d.watched }
    })
}

/**
 * Names of the other devices that dropped within 1 s of any of these drops: a shared cause (power or the CAN trunk).
 * Strictly under 1 s here, while dropAround counts exactly TOGETHER_SECONDS apart as together: kept as it was. When
 * either device is read by the companion (once a second), its flag can fall a read later, so 2 s.
 */
function devicesDroppedWith(others: { name: string; drops: number[]; watched: boolean }[], drops: Episode[], late: boolean): string[] {
  const within = (o: { watched: boolean }) => (late || o.watched ? 1 + DEVICE_READ_SECONDS : 1)
  return others
    .filter((o) => o.drops.some((t) => drops.some((own) => Math.abs(t - own.start) < within(o))))
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

