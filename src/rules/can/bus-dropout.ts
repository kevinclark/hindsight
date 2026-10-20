/**
 * Did a whole CAN bus go down at once?
 *
 * Checks: for each CAN bus the robot profile maps (canBuses), whether every device on it that reports its health (at
 * least 3) dropped within 1 s of each other, while enabled (in Foresight: while disabled since start-up settled).
 * That is one finding about the bus; can/device-dropout leaves those drops out of its per-device findings.
 * Why: MTTD 2025 Q41: at 745 s every CAN device stopped reporting for 58 s while the loop ran on; the swerve modules'
 * refresh status went CanMessageStale and the Pigeon's flag false. Only the Pigeon was reported, as if alone.
 */
import { isFalse, plural, round, rule, type Problem } from '../rule.ts'
import type { Episode, MatchView, Signal } from '../view.ts'
import { canBuses, dropAround, isBusWide, LOW_VOLTS, plotDrops, readDrops, secondsWatched, TOGETHER_SECONDS, watched, windowStart, type CanBus } from './bus.ts'

/** The evidence line that names the bus's devices (links.ts reads it to tell which alerts are about the bus). */
export const BUS_DEVICES = 'devices that report their health on this bus'

export default rule({
  id: 'can/bus-dropout',
  title: 'Whole CAN bus dropped out',
  severity: 'error',
  who: ['pit'],
  meaning: 'Every device on one CAN bus that reports its health stopped at the same moment, so the bus itself went down, not one device. Everything on that bus stopped working until it came back.',
  causes: [
    { id: 'bus', cause: 'The whole CAN bus went down: the CANivore (its USB cable to the roboRIO, its power) or the wiring at it', look: 'the CANivore\'s USB cable, power connector and status light' },
    { id: 'can-chain', cause: 'A break in the CAN wiring: a loose or damaged connector or wire between the devices that kept reporting and the ones that did not', look: 'the CAN chain from the last device that kept reporting to the first that did not: tug each connector and wire, look for pinched or cracked wire' },
    { id: 'battery-sag', cause: 'The battery sagged so low that the devices lost power (voltage under about 7 V)', look: 'Power tab: battery voltage at each drop; the power/brownout and power/margin findings' },
    { id: 'device-fault', cause: 'One device faulting and taking the others with it', look: 'its status light during a dropout; the vendor tool (Phoenix Tuner, REV Hardware Client) for firmware and faults' },
  ],
  nextStep: 'Check the CANivore itself: its USB cable to the roboRIO (seated and strain-relieved), its power wiring and the CAN wiring at it. Have the code log its status every loop, so the next drop says why.',
  incident: 'MTTD 2025 Q41: the whole CANivore bus gone for 58 s (mttd-2025-context.md §1)',
  needsProfile: true,

  check(match) {
    if (!match.profile.canBuses?.length) return match.couldNotCheck('the robot profile maps no CAN bus')
    const problems: Problem[] = []
    for (const bus of canBuses(match)) {
      // Read from one member's own Connected flag, so a drop is counted the same way can/device-dropout counts it.
      const flag = bus.reporter && match.signalIfLogged(bus.reporter.key, `${bus.reporter.name} connected`)
      if (!flag) continue
      // `touching` keeps a drop that spans the auto→teleop gap as one drop.
      const drops = flag.episodes(isFalse, { touching: watched(match) }).filter((d) => isBusWide(bus, d))
      if (drops.length) problems.push(busProblem(bus, drops, match))
    }
    return problems
  },
})

/** The finding for drops of the whole bus: every member that reports its health dropped within 1 s. */
function busProblem(bus: CanBus, drops: Episode[], match: MatchView): Problem {
  const battery = match.signal('batteryVoltage')
  // A bus already off when the watched window began is timed from that start and has no battery reading.
  const { timed, alreadyOff, voltages, text: voltageText } = readDrops(match, battery, drops)
  const first = timed[0].start
  const earlier = lowestEarlier(match, battery, first)
  const low = voltages.length > 0 && voltages.every((v) => v < LOW_VOLTS)
  // A deeper but shorter sag earlier doesn't rule a sag out (Q41: cause unknown), but it does stop it being "likely".
  const sagExplains = low && !(earlier <= Math.min(...voltages))
  // How long the bus was gone: until the last member came back, per drop.
  const gone = drops.map((d, i) => lastBackAt(bus, d.start) - timed[i].start)
  const statuses = reportedStatuses(match, bus, drops[0].start + TOGETHER_SECONDS)
  const pastEnd = match.matchEnd !== null && first + gone[0] > match.matchEnd ? ' (past the end of the match)' : ''
  const times = drops.length > 1 ? `, ${drops.length} times, first` : ''
  // At the first drop, which members came back (after how long) and which were still off at the end of the log.
  const { cameBack, neverBack } = whoCameBack(bus, drops[0].start, match)
  const withoutThem = Math.max(0, ...neverBack.map((m) => secondsWatched(match, m.drop)))
  const when = alreadyOff[0] ? `already off when ${windowStart(match)} ${match.whenAt(first)}` : match.whenAt(first)
  // Some devices came back and kept reporting while others never did: the break is between them, not at the CANivore.
  const keptReporting = neverBack.length > 0 && cameBack.length > 0
  const howLong = neverBack.length === 0
    ? `for ${gone[0].toFixed(0)} s${pastEnd}`
    : `${neverBack.length} of them never came back (still off at the end of the log, ${round(withoutThem)} s of the enabled match without them)`
  const kept = keptReporting
    ? `; ${plural(cameBack.length, 'device')} on the same bus came back and kept reporting: the break is in the CAN wiring between them and the rest`
    : ''

  const likely = sagExplains ? ['battery-sag'] : []
  likely.push(keptReporting ? 'can-chain' : 'bus')
  const ruledOut: Record<string, string> = {
    'device-fault': `all ${bus.members.length} devices that report their health on the bus dropped together`,
  }
  if (voltages.length > 0 && voltages.every((v) => v >= LOW_VOLTS + 0.5)) ruledOut['battery-sag'] = 'the battery stayed above 7.5 V at every drop'

  return {
    message: `Every device on the ${bus.name} bus that reports its health (${bus.members.length}) stopped reporting at once${times} ${when}, ${howLong}${kept}`,
    at: first,
    about: `${bus.name} bus`,
    likely,
    ruledOut,
    nextStep: keptReporting
      ? `Check the CAN chain between the last device that kept reporting (${cameBack.map((m) => m.name).join(', ')}) and the first that did not: tug the connectors and wires at those devices and the ones next to them. Only if nothing is loose, check the ${bus.name} itself.`
      : `Check the ${bus.name} itself: its USB cable to the roboRIO (seated and strain-relieved), its power wiring and the CAN wiring at it. Have the code log the ${bus.name}'s status every loop, so the next drop says why.`,
    evidence: {
      [BUS_DEVICES]: bus.members.map((m) => m.name).join(', '),
      drops: drops.length,
      'seconds until every device was back': gone.map((g, i) => (stillOffAtEnd(match, bus, drops[i]) ? 'never' : g.toFixed(1))).join(', '),
      'back after (s)': neverBack.length ? cameBack.map((m) => `${m.name} ${m.seconds.toFixed(1)}`).join(', ') || 'none' : undefined,
      'still off at the end of the log': neverBack.length ? neverBack.map((m) => m.name).join(', ') : undefined,
      'status the devices reported': statuses.length ? statuses.join(', ') : undefined,
      'lowest battery voltage in the 0.5 s before each drop (V)': voltageText.join(', '),
      'lowest battery voltage earlier while enabled, with no bus drop (V)': Number.isFinite(earlier) ? round(earlier) : undefined,
    },
    measured: [{ label: 'whole-bus drops', value: drops.length, unit: '' }],
    plot: plotDrops(battery, timed, 5, first + gone[0] + 2),
  }
}

/** The members' own drops that started with the bus drop at time t: who was back, after how long, and who never was. */
function whoCameBack(bus: CanBus, t: number, match: MatchView) {
  const cameBack: { name: string; seconds: number }[] = []
  const neverBack: { name: string; drop: Episode }[] = []
  for (const member of bus.members) {
    const drop = dropAround(member.drops, t)
    if (!drop) continue
    if (drop.end >= match.logEnd) neverBack.push({ name: member.name, drop })
    else cameBack.push({ name: member.name, seconds: drop.seconds })
  }
  return { cameBack, neverBack }
}

/** Was any member still off at the end of the log from the bus drop that started at this episode? */
function stillOffAtEnd(match: MatchView, bus: CanBus, drop: Episode): boolean {
  return whoCameBack(bus, drop.start, match).neverBack.length > 0
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

