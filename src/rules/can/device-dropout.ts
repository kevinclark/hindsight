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
import { isFalse, rule, round, type Problem } from '../rule.ts'
import type { DeviceView, Episode, MatchView } from '../view.ts'

const LOW_VOLTS = 7
const TOGETHER_SECONDS = 1 // drops starting this close count as one event (assumed; the same window as "other devices" below)
const MIN_BUS_MEMBERS = 3 // "every device on the bus" needs at least this many reporting their health (assumed)

/**
 * The CAN bus this device is on (from the profile), each member's drops, and which member reports a whole-bus drop
 * (the first one that is a device). Null when the profile maps no bus for it, or too few members are in the log.
 */
function busOf(match: MatchView, device: string) {
  const bus = match.profile.canBuses?.find((b) => b.members.some((m) => m.name === device))
  if (!bus) return null
  const present = bus.members.filter((m) => match.has(m.key))
  if (present.length < MIN_BUS_MEMBERS) return null
  const devices = new Set([...match.profile.motorGroups.flatMap((g) => g.motors.filter((m) => m.connected).map((m) => m.name)), ...match.profile.otherDevices.map((d) => d.name)])
  const members = present.map((m) => ({ ...m, drops: match.health(m.key, m.ok, m.name).episodes(isFalse, { touching: watched(match) }) }))
  return { name: bus.name, members, reporter: present.find((m) => devices.has(m.name))?.name }
}

type Bus = NonNullable<ReturnType<typeof busOf>>

/** The member's drop that started within 1 s of time t, if any (one already under way is a separate problem). */
const dropAround = (drops: Episode[], t: number) => drops.find((e) => Math.abs(e.start - t) <= TOGETHER_SECONDS)

/** When each other device dropped off CAN while enabled (every motor with a Connected flag, and the other devices). */
function otherDevices(match: MatchView, except: string) {
  const all = [
    ...match.profile.motorGroups.flatMap((g) => g.motors.filter((m) => m.connected).map((m) => ({ name: m.name, key: m.connected! }))),
    ...match.profile.otherDevices.map((d) => ({ name: d.name, key: d.connected })),
  ]
  return all
    .filter((d) => d.name !== except && match.has(d.key))
    .map((d) => ({ name: d.name, drops: match.signal(d.key).episodes(isFalse, { touching: watched(match) }).map((e) => e.start) }))
}

/** While enabled, plus (Foresight) the disabled stretch being checked. */
function watched(match: MatchView) {
  return [...match.enabled, ...match.beforeEnable]
}

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
  const closeCall = voltages.some((v) => Math.abs(v - LOW_VOLTS) < 0.5)
  // No battery voltage logged just before a drop (e.g. Foresight: a device already off at the start of the stretch).
  const unknownVolts = voltages.some((v) => Number.isNaN(v))
  // Other devices that dropped within 1 s of any of this one's drops: a shared cause (power or the CAN trunk).
  const others = otherDevices(match, device.name)
  const together = others.filter((o) => o.drops.some((d) => drops.some((own) => Math.abs(d - own.start) < 1))).map((o) => o.name)
  const allLow = lowOnes === drops.length
  const likely: string[] = []
  const ruledOut: Record<string, string> = {}
  if (allLow) likely.push('battery-sag')
  else if (lowOnes === 0 && !closeCall && !unknownVolts) ruledOut['battery-sag'] = 'the battery stayed above 7 V at every drop'
  if (together.length) {
    likely.push('shared-wiring')
    ruledOut['device-fault'] = `${together.length} other device${together.length === 1 ? '' : 's'} dropped at the same moment`
  } else if (others.length) {
    ruledOut['shared-wiring'] = 'no other device dropped at the same moment'
    likely.push(allLow ? 'device-power' : 'can-connector')
  }
  const nextStep = allLow ? 'The battery was low at every drop: fix the voltage sag first (Power tab), then wiggle-test the power connector on that device.'
    : together.length ? `${together.join(', ')} dropped at the same moment: check what they share (the same CAN branch or splice, the same power channel).`
    : undefined
  const cause = lowOnes === drops.length ? 'power path (every drop at low voltage)'
    : unknownVolts ? 'not known (no battery voltage logged just before a drop)'
    : lowOnes === 0 ? 'CAN wiring or connector (voltage was normal)'
    : 'mixed: some drops at low voltage'
  return {
    message: `${device.name} dropped off CAN ${drops.length} time${drops.length === 1 ? '' : 's'}, first at ${match.when(drops[0].start)}`,
    at: drops[0].start,
    evidence: {
      drops: drops.length,
      'seconds missing': round(drops.reduce((s, d) => s + d.seconds, 0)),
      'lowest battery voltage in the 0.5 s before each drop (V)': voltages.map((v) => v.toFixed(2)).join(', '),
      'other devices dropped at the same moment': together.length ? together.join(', ') : others.length ? 'none' : 'not checked (no other devices)',
      'likely cause': closeCall ? `possibly ${cause}; a voltage is within 0.5 V of the ${LOW_VOLTS} V line` : cause,
    },
    likely, ruledOut, nextStep,
    measured: [{ label: 'drops off CAN', value: drops.length, unit: '' }],
    plot: [battery], plotUnit: 'V', plotFrom: drops[0].start - 3, plotTo: drops[drops.length - 1].end + 2,
    plotMarks: drops.map((d) => d.start), plotLine: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
  }
}

/** The finding for drops of the whole bus: every member that reports its health dropped within 1 s. */
function busProblem(bus: Bus, drops: Episode[], match: MatchView): Problem {
  const battery = match.signal('batteryVoltage')
  const voltages = drops.map((d) => battery.lowest(match.before(d.start, 0.5)).value)
  // A deeper sag earlier in the match, while enabled, that didn't drop the bus: low voltage alone doesn't explain it.
  const beforeFirst = match.enabled.filter((iv) => iv.start < drops[0].start - 0.5).map((iv) => ({ start: iv.start, end: Math.min(iv.end, drops[0].start - 0.5) }))
  const earlier = beforeFirst.length ? battery.lowest(beforeFirst).value : NaN
  const low = voltages.every((v) => v < LOW_VOLTS)
  // A deeper but shorter sag earlier doesn't rule a sag out (Q41: cause unknown), but it does stop it being "likely".
  const sagExplains = low && !(earlier <= Math.min(...voltages))
  // How long the bus was gone: until the last member came back, per drop.
  const gone = drops.map((d) => Math.max(...bus.members.map((m) => dropAround(m.drops, d.start)!.end)) - d.start)
  const statuses = [...new Set(bus.members.flatMap((m) => { const x = m.ok === undefined ? '' : match.text(m.key).at(drops[0].start + TOGETHER_SECONDS); return x && x !== m.ok ? [x] : [] }))]
  const ruledOut: Record<string, string> = { 'device-fault': `all ${bus.members.length} devices that report their health on the bus dropped together` }
  if (voltages.every((v) => v >= LOW_VOLTS + 0.5)) ruledOut['battery-sag'] = 'the battery stayed above 7.5 V at every drop'
  const pastEnd = match.matchEnd !== null && drops[0].start + gone[0] > match.matchEnd ? ' (past the end of the match)' : ''
  return {
    message: `Every device on the ${bus.name} bus that reports its health (${bus.members.length}) stopped reporting at once${drops.length > 1 ? `, ${drops.length} times, first` : ''} at ${match.when(drops[0].start)}, for ${gone[0].toFixed(0)} s${pastEnd}`,
    at: drops[0].start,
    about: `${bus.name} bus`,
    likely: sagExplains ? ['battery-sag', 'bus'] : ['bus'],
    ruledOut,
    nextStep: `Check the ${bus.name} itself: its USB cable to the roboRIO (seated and strain-relieved), its power wiring and the CAN wiring at it. Have the code log the ${bus.name}'s status every loop, so the next drop says why.`,
    evidence: {
      'devices that report their health on this bus': bus.members.map((m) => m.name).join(', '),
      drops: drops.length,
      'seconds until every device was back': gone.map((g) => g.toFixed(1)).join(', '),
      ...(statuses.length ? { 'status the devices reported': statuses.join(', ') } : {}),
      'lowest battery voltage in the 0.5 s before each drop (V)': voltages.map((v) => v.toFixed(2)).join(', '),
      ...(Number.isFinite(earlier) ? { 'lowest battery voltage earlier while enabled, with no bus drop (V)': round(earlier) } : {}),
    },
    measured: [{ label: 'whole-bus drops', value: drops.length, unit: '' }],
    plot: [battery], plotUnit: 'V', plotFrom: drops[0].start - 5, plotTo: drops[0].start + gone[0] + 2,
    plotMarks: drops.map((d) => d.start), plotLine: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
  }
}
