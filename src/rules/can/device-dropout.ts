/**
 * Did a motor controller or sensor drop off CAN while enabled?
 *
 * Checks: each device's Connected flag going false while the robot was enabled (in Foresight, the live pit check:
 * while disabled since start-up settled), and the lowest battery voltage in
 * the 0.5 s before. A drop at low voltage points at the power path (the device browned out); a drop at normal
 * voltage points at CAN wiring or a connector.
 * Why: CalGames 2026 P0: flywheel follower 16 alone dropped off CAN 7 times, each at 5.85–6.31 V.
 *
 * Whole bus: when the profile maps a CAN bus (canBuses) and every device on it that reports its health (at least 3)
 * drops within 1 s, that is one finding about the bus, reported once, not one per device.
 * Why: MTTD 2025 Q41: at 745 s every CAN device stopped reporting for 58 s while the loop ran on; the swerve modules'
 * refresh status went CanMessageStale and the Pigeon's flag false. Only the Pigeon was reported, as if alone.
 */
import { isFalse, plural, round, rule, totalSeconds, type Problem } from '../rule.ts'
import type { DeviceView, Episode, MatchView, Signal } from '../view.ts'
import { busOf, connectedDevices, dropAround, TOGETHER_SECONDS, watched, type CanBus } from './bus.ts'

const LOW_VOLTS = 7

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
    { id: 'bus', cause: 'The whole CAN bus went down: the CANivore (its USB cable to the roboRIO, its power) or the wiring at it', look: 'whether every device on that bus dropped at once (the finding says); the CANivore\'s USB cable, power connector and status light' },
  ],
  nextStep: 'Tug-test the CAN connectors on that device and the ones next to it, and check the CAN termination at the far end of the chain.',
  incident: 'CalGames 2026 P0: flywheel follower 16 off CAN 7 times at 5.85–6.31 V (P0 analysis); #in-hindsight: ≥ 11 CAN dropout episodes; MTTD 2025 Q41: the whole CANivore bus gone for 58 s (mttd-2025-context.md §1)',
  forEach: 'device',

  check(device, match) {
    // `touching` keeps a drop that spans the auto→teleop gap as one drop.
    const all = device.connected().episodes(isFalse, { touching: watched(match) })
    if (all.length === 0) return
    const bus = busOf(match, device.name)
    const busWide = (d: Episode) => !!bus && bus.members.every((m) => dropAround(m.drops, d.start))
    const problems: Problem[] = []
    // A whole-bus drop is one finding, from one member of the bus; the others leave it out.
    const busDrops = all.filter(busWide)
    if (bus && busDrops.length && bus.reporter === device.name) problems.push(busProblem(bus, busDrops, match))
    const own = all.filter((d) => !busWide(d))
    if (own.length) problems.push(deviceProblem(device, own, match))
    return problems
  },
})

/** The finding for one device's own drops (not part of a whole-bus drop). */
function deviceProblem(device: DeviceView, drops: Episode[], match: MatchView): Problem {
  const battery = match.signal('batteryVoltage')
  // The flag goes false only after the device misses its status frames, so look at the 0.5 s before it.
  const voltages = drops.map((d) => battery.lowest(match.before(d.start, 0.5)).value)
  const lowOnes = voltages.filter((v) => v < LOW_VOLTS).length
  const allLow = lowOnes === drops.length
  const closeCall = voltages.some((v) => Math.abs(v - LOW_VOLTS) < 0.5)
  // No battery voltage logged just before a drop (e.g. Foresight: a device already off at the start of the stretch).
  const unknownVolts = voltages.some((v) => Number.isNaN(v))
  const others = otherDevices(match, device.name)
  const together = devicesDroppedWith(others, drops)

  const likely: string[] = []
  const ruledOut: Record<string, string> = {}
  if (allLow) {
    likely.push('battery-sag')
  } else if (lowOnes === 0 && !closeCall && !unknownVolts) {
    ruledOut['battery-sag'] = 'the battery stayed above 7 V at every drop'
  }
  if (together.length) {
    likely.push('shared-wiring')
    ruledOut['device-fault'] = `${plural(together.length, 'other device')} dropped at the same moment`
  } else if (others.length) {
    ruledOut['shared-wiring'] = 'no other device dropped at the same moment'
    likely.push(allLow ? 'device-power' : 'can-connector')
  }

  let nextStep: string | undefined
  if (allLow) {
    nextStep = 'The battery was low at every drop: fix the voltage sag first (Power tab), then wiggle-test the power connector on that device.'
  } else if (together.length) {
    nextStep = `${together.join(', ')} dropped at the same moment: check what they share (the same CAN branch or splice, the same power channel).`
  }

  let cause: string
  if (allLow) {
    cause = 'power path (every drop at low voltage)'
  } else if (unknownVolts) {
    cause = 'not known (no battery voltage logged just before a drop)'
  } else if (lowOnes === 0) {
    cause = 'CAN wiring or connector (voltage was normal)'
  } else {
    cause = 'mixed: some drops at low voltage'
  }
  const likelyCause = closeCall ? `possibly ${cause}; a voltage is within 0.5 V of the ${LOW_VOLTS} V line` : cause

  let othersDropped: string
  if (together.length) {
    othersDropped = together.join(', ')
  } else if (others.length) {
    othersDropped = 'none'
  } else {
    othersDropped = 'not checked (no other devices)'
  }

  return {
    message: `${device.name} dropped off CAN ${plural(drops.length, 'time')}, first at ${match.when(drops[0].start)}`,
    at: drops[0].start,
    evidence: {
      drops: drops.length,
      'seconds missing': round(totalSeconds(drops)),
      'lowest battery voltage in the 0.5 s before each drop (V)': voltages.map((v) => v.toFixed(2)).join(', '),
      'other devices dropped at the same moment': othersDropped,
      'likely cause': likelyCause,
    },
    likely, ruledOut, nextStep,
    measured: [{ label: 'drops off CAN', value: drops.length, unit: '' }],
    plot: plotDrops(battery, drops, 3, drops[drops.length - 1].end + 2),
  }
}

/** The finding for drops of the whole bus: every member that reports its health dropped within 1 s. */
function busProblem(bus: CanBus, drops: Episode[], match: MatchView): Problem {
  const battery = match.signal('batteryVoltage')
  const first = drops[0].start
  const voltages = drops.map((d) => battery.lowest(match.before(d.start, 0.5)).value)
  const earlier = lowestEarlier(match, battery, first)
  const low = voltages.every((v) => v < LOW_VOLTS)
  // A deeper but shorter sag earlier doesn't rule a sag out (Q41: cause unknown), but it does stop it being "likely".
  const sagExplains = low && !(earlier <= Math.min(...voltages))
  // How long the bus was gone: until the last member came back, per drop.
  const gone = drops.map((d) => lastBackAt(bus, d.start) - d.start)
  const statuses = reportedStatuses(match, bus, first + TOGETHER_SECONDS)
  const pastEnd = match.matchEnd !== null && first + gone[0] > match.matchEnd ? ' (past the end of the match)' : ''
  const times = drops.length > 1 ? `, ${drops.length} times, first` : ''

  const likely = sagExplains ? ['battery-sag', 'bus'] : ['bus']
  const ruledOut: Record<string, string> = {
    'device-fault': `all ${bus.members.length} devices that report their health on the bus dropped together`,
  }
  if (voltages.every((v) => v >= LOW_VOLTS + 0.5)) ruledOut['battery-sag'] = 'the battery stayed above 7.5 V at every drop'

  return {
    message: `Every device on the ${bus.name} bus that reports its health (${bus.members.length}) stopped reporting at once${times} at ${match.when(first)}, for ${gone[0].toFixed(0)} s${pastEnd}`,
    at: first,
    about: `${bus.name} bus`,
    likely,
    ruledOut,
    nextStep: `Check the ${bus.name} itself: its USB cable to the roboRIO (seated and strain-relieved), its power wiring and the CAN wiring at it. Have the code log the ${bus.name}'s status every loop, so the next drop says why.`,
    evidence: {
      'devices that report their health on this bus': bus.members.map((m) => m.name).join(', '),
      drops: drops.length,
      'seconds until every device was back': gone.map((g) => g.toFixed(1)).join(', '),
      'status the devices reported': statuses.length ? statuses.join(', ') : undefined,
      'lowest battery voltage in the 0.5 s before each drop (V)': voltages.map((v) => v.toFixed(2)).join(', '),
      'lowest battery voltage earlier while enabled, with no bus drop (V)': Number.isFinite(earlier) ? round(earlier) : undefined,
    },
    measured: [{ label: 'whole-bus drops', value: drops.length, unit: '' }],
    plot: plotDrops(battery, drops, 5, first + gone[0] + 2),
  }
}

/** The battery voltage from `before` s ahead of the first drop to time `to`, marking each drop, with the 7 V line. */
function plotDrops(battery: Signal, drops: Episode[], before: number, to: number) {
  return {
    signals: [battery], unit: 'V', from: drops[0].start - before, to,
    marks: drops.map((d) => d.start), line: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
  }
}

/** The deepest battery sag earlier in the match, while enabled, that didn't drop the bus (NaN if none). */
function lowestEarlier(match: MatchView, battery: Signal, firstDrop: number): number {
  const cutoff = firstDrop - 0.5
  const earlierWindows = match.enabled
    .filter((iv) => iv.start < cutoff)
    .map((iv) => ({ start: iv.start, end: Math.min(iv.end, cutoff) }))
  return earlierWindows.length ? battery.lowest(earlierWindows).value : NaN
}

/** When the last member of the bus came back from the drop that started at time t. */
function lastBackAt(bus: CanBus, t: number): number {
  const drops = bus.members.flatMap((m) => dropAround(m.drops, t) ?? [])
  return Math.max(...drops.map((e) => e.end))
}

/** What the devices said when the bus went (the status text, for devices that say more than true/false). */
function reportedStatuses(match: MatchView, bus: CanBus, t: number): string[] {
  const statuses = new Set<string>()
  for (const member of bus.members) {
    if (member.ok === undefined) continue
    const status = match.text(member.key).at(t)
    if (status && status !== member.ok) statuses.add(status)
  }
  return [...statuses]
}

/** When each other device dropped off CAN while enabled (every motor with a Connected flag, and the other devices). */
function otherDevices(match: MatchView, except: string) {
  return connectedDevices(match)
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
