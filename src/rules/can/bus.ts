/**
 * Shared by can/device-dropout and can/bus-dropout: the CAN buses the profile maps (canBuses), when each device on
 * one dropped, and the battery plot both findings draw. Not a rule itself.
 */
import { isFalse, voltageList } from '../rule.ts'
import type { Episode, MatchView, Signal } from '../view.ts'

export const LOW_VOLTS = 7
/** A Connected flag goes false this long after the device stops answering (Phoenix's isConnected). */
export const DROP_LOOK_BACK = 0.5
export const TOGETHER_SECONDS = 1 // drops starting this close count as one event (assumed)
const MIN_BUS_MEMBERS = 3 // "every device on the bus" needs at least this many reporting their health (assumed)

/**
 * A CAN bus from the profile: the devices on it that report their health, with the times each dropped.
 * `ok` is the status text that means healthy (some devices report text, not a true/false flag).
 * `reporter` is the member whose own Connected flag a whole-bus drop is read from: the first one that is a device.
 */
export interface CanBus {
  name: string
  members: { name: string; key: string; ok?: string; drops: Episode[] }[]
  reporter: { name: string; key: string } | undefined
}

/** The profile's CAN buses that can be judged in this log (at least 3 members logged). */
export function canBuses(match: MatchView): CanBus[] {
  return (match.profile.canBuses ?? []).flatMap((bus) => busFromProfile(match, bus) ?? [])
}

/** The CAN bus this device is on, or null when the profile maps none for it or too few members are in the log. */
export function busOf(match: MatchView, device: string): CanBus | null {
  const bus = match.profile.canBuses?.find((b) => b.members.some((m) => m.name === device))
  return bus ? busFromProfile(match, bus) : null
}

/** Did every member of the bus drop within 1 s of this drop? */
export function isBusWide(bus: CanBus | null, drop: Episode): boolean {
  return !!bus && bus.members.every((m) => dropAround(m.drops, drop.start))
}

/** The member's drop that started within 1 s of time t, if any (one already under way is a separate problem). */
export function dropAround(drops: Episode[], t: number) {
  return drops.find((e) => Math.abs(e.start - t) <= TOGETHER_SECONDS)
}

/**
 * While enabled, plus (Foresight) the disabled stretch being checked. Every enable in the log, so a queue or pit enable
 * in a match log counts, and its drop reads "before the match". Left this way until a real case says otherwise:
 * 4 of 89 on-field logs have such enables, only one of those logs any device's health, and none has a drop in them
 * (2026-11-05), so no log tests it.
 */
export function watched(match: MatchView) {
  return [...match.enabled, ...match.beforeEnable]
}

/**
 * When the first watched window began, if this drop was already under way then (a device off from boot, or off
 * since before the robot first enabled); null for any other drop. A drop that began while disabled between two
 * watched windows (say, auto to teleop) is not this: it has its own start and its own battery reading.
 */
export function alreadyOffAt(match: MatchView, drop: Episode): number | null {
  const firstStart = Math.min(...watched(match).map((w) => w.start))
  return drop.start <= firstStart ? firstStart : null
}

/** How long this drop lasted inside the watched windows (s): time off CAN while disabled doesn't count. */
export function secondsWatched(match: MatchView, drop: Episode): number {
  return watched(match).reduce((sum, w) => sum + Math.max(0, Math.min(drop.end, w.end) - Math.max(drop.start, w.start)), 0)
}

/** What the watched window began with, for "already off when ...": the robot enabling, or (Foresight) the check starting. */
export function windowStart(match: MatchView): string {
  return match.beforeEnable.length > 0 ? 'the check started' : 'the robot enabled'
}

/** One drop as the findings tell it. */
export interface DropReading {
  /** The drop as the flag recorded it. */
  drop: Episode
  /** The same drop, starting where it is timed from (the window start for a drop already under way). */
  timed: Episode
  /** True for a drop already under way when the first watched window began. */
  alreadyOff: boolean
  /** The lowest battery voltage before it; null for a drop already under way, which has no voltage to read. */
  volts: number | null
  /** For the evidence: its voltage, or that it was already off. */
  text: string
}

/**
 * The lowest battery voltage in the `lookBack` s before each drop (the flag goes false after the device misses its
 * frames: 0.5 s for a flag the robot code reads every loop, longer for one read once a second).
 */
export function readDrops(match: MatchView, battery: Signal, drops: Episode[], lookBack = DROP_LOOK_BACK) {
  const pit = match.beforeEnable.length > 0
  const alreadyOffText = `already off when ${pit ? 'the check started' : 'enabled'}`
  const readings = drops.map((drop): DropReading => {
    const offAt = alreadyOffAt(match, drop)
    if (offAt !== null) return { drop, timed: { ...drop, start: offAt }, alreadyOff: true, volts: null, text: alreadyOffText }
    const volts = battery.lowest(match.before(drop.start, lookBack)).value
    return { drop, timed: drop, alreadyOff: false, volts, text: voltageList([volts]) }
  })
  // The voltages of the drops that began while watched: the sag verdicts rest on these only.
  const voltages = readings.flatMap((r) => (r.volts === null ? [] : [r.volts]))
  // How the drops' voltage sentence says "every": all of them, or only those that began while watched.
  const everyDrop = voltages.length < drops.length ? `at every drop that began ${pit ? 'while the check ran' : 'while enabled'}` : 'at every drop'
  return { readings, voltages, everyDrop }
}

/** The battery voltage from `before` s ahead of the first drop to time `to`, marking each drop, with the 7 V line. */
export function plotDrops(battery: Signal, drops: Episode[], before: number, to: number) {
  return {
    signals: [battery], unit: 'V', from: drops[0].start - before, to,
    marks: drops.map((d) => d.start), line: { value: LOW_VOLTS, label: `${LOW_VOLTS} V` },
  }
}

type ProfileBus = NonNullable<MatchView['profile']['canBuses']>[number]

function busFromProfile(match: MatchView, bus: ProfileBus): CanBus | null {
  const present = bus.members.filter((m) => match.has(m.key))
  if (present.length < MIN_BUS_MEMBERS) return null
  const devices = match.connectedDevices()
  const members = present.map((m) => ({
    ...m,
    drops: match.health(m.key, m.ok, m.name).episodes(isFalse, { touching: watched(match) }),
  }))
  const reporter = present.flatMap((m) => devices.find((d) => d.name === m.name) ?? [])[0]
  return { name: bus.name, members, reporter }
}
