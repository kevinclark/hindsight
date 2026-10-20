/**
 * Parents: a finding that names a group of findings no single one of them explains. When 25 devices drop off CAN in
 * the same quarter second, that is one event, not 25 faults, but none of the 25 is the cause of the others. A parent
 * says so in one row, and the 25 are listed under it. Nothing is deleted: each keeps its evidence, one click away,
 * and every count still counts them. The parent itself adds nothing to any count.
 *
 * Each parent names the rule whose findings it groups, says when two of them belong together, and how many make a
 * group, measured on the real matches named above it. A finding that a link (links.ts) already explains is never
 * grouped: the specific explanation wins.
 * To add one, copy a parent, then run `npm run golden` before and after and look at every finding that changed.
 */
import { likely, parent, type Parent } from './rule.ts'
import type { Finding } from './types.ts'

export const PARENTS: Parent[] = [
  // CalGames 2026 Q2 with no CAN bus in the robot profile: 25 devices dropped off CAN between 614.04 and 614.28 s,
  // one event (the bus), listed as 25 separate errors. Other teams' logs and new robots have no bus mapped.
  parent({
    id: 'can/devices-dropped-together',
    title: 'CAN devices dropped together',
    over: 'can/device-dropout',
    // The device's first drop started no more than 1 s after the first device's.
    together: (first, other) => isBetween(secondsAfter(first, other), 0, 1),
    atLeast: 3,
    name: (devices) => `${devices.length} CAN devices dropped within ${spreadOf(devices).toFixed(2)} s`,
    why: 'it dropped off CAN with the others: one event, not separate faults',
    who: ['pit'],
    meaning: 'Several devices dropped off CAN at the same moment. That is one event with one cause they share, not a fault in each device.',
    causes: [
      { id: 'battery-sag', cause: 'The battery sagged so low that the devices lost power (voltage under about 7 V)', look: 'Power tab: battery voltage at the drop; the power/brownout and power/margin findings' },
      { id: 'bus', cause: 'The whole CAN bus went down: the CANivore (its USB cable to the roboRIO, its power) or the wiring at it', look: 'the CANivore\'s USB cable, power connector and status light' },
      { id: 'shared-wiring', cause: 'Wiring or power these devices share: a CAN splice or branch, a shared power breaker or channel', look: 'what the devices listed below have in common: the same CAN branch or splice, the same PDH channel' },
    ],
    likely: (devices) => (devices.every((d) => likely(d, 'battery-sag')) ? ['battery-sag'] : ['bus', 'shared-wiring']),
    evidence: (devices) => ({
      devices: devices.map((d) => d.about).join(', '),
      'first drop (robot time, s)': devices[0].time ?? NaN,
      'seconds from the first drop to the last': spreadOf(devices),
    }),
    nextStep: 'Look at what these devices share: the CANivore and its USB cable, a CAN splice, a power channel. If they are all on one bus, add it to the robot profile (canBuses), so Hindsight can say when the whole bus drops.',
    incident: 'CalGames 2026 Q2: 25 devices off CAN within 0.25 s, listed as 25 separate errors when the robot profile mapped no bus',
  }),
]

/** How many seconds after the first finding the second one happened (NaN if either has no time). */
function secondsAfter(first: Finding, second: Finding): number {
  return (second.time ?? NaN) - (first.time ?? NaN)
}

/** Is x from low to high? (False for NaN.) */
function isBetween(x: number, low: number, high: number): boolean {
  return x >= low && x <= high
}

/** Seconds from the first finding's time to the last one's (the findings are in time order). */
function spreadOf(findings: Finding[]): number {
  return Math.round(secondsAfter(findings[0], findings[findings.length - 1]) * 100) / 100
}
