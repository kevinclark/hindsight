/**
 * Shared by can/device-dropout and can/bus-dropout: the CAN buses the profile maps (canBuses), when each device on
 * one dropped, and the battery plot both findings draw. Not a rule itself.
 */
import { isFalse } from '../rule.ts'
import type { Episode, MatchView, Signal } from '../view.ts'

export const LOW_VOLTS = 7
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

/** While enabled, plus (Foresight) the disabled stretch being checked. */
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
