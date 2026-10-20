/**
 * Helpers for can/device-dropout: which devices report a Connected flag, and the CAN bus a device is on.
 * The profile's canBuses lists the devices on each bus that report their health.
 */
import { isFalse } from '../rule.ts'
import type { Episode, MatchView } from '../view.ts'

export const TOGETHER_SECONDS = 1 // drops starting this close count as one event (assumed)
const MIN_BUS_MEMBERS = 3 // "every device on the bus" needs at least this many reporting their health (assumed)

/** A device on a bus that reports its health, with the times it dropped. */
export interface BusMember {
  name: string
  key: string
  /** The status text that means healthy (some devices report text, not a true/false flag). */
  ok?: string
  drops: Episode[]
}

export interface CanBus {
  name: string
  members: BusMember[]
  /** The member that reports a whole-bus drop: the first one that is a device (it has a Connected flag). */
  reporter: string | undefined
}

/** While enabled, plus (Foresight) the disabled stretch being checked. */
export function watched(match: MatchView) {
  return [...match.enabled, ...match.beforeEnable]
}

/** Every device with a Connected flag in the log's profile: each motor that has one, and the other devices. */
export function connectedDevices(match: MatchView): { name: string; key: string }[] {
  const motors = match.profile.motorGroups.flatMap((g) =>
    g.motors.flatMap((m) => (m.connected ? [{ name: m.name, key: m.connected }] : [])),
  )
  const others = match.profile.otherDevices.map((d) => ({ name: d.name, key: d.connected }))
  return [...motors, ...others]
}

/** The member's drop that started within 1 s of time t, if any (one already under way is a separate problem). */
export function dropAround(drops: Episode[], t: number) {
  return drops.find((e) => Math.abs(e.start - t) <= TOGETHER_SECONDS)
}

/**
 * The CAN bus this device is on (from the profile), each member's drops, and which member reports a whole-bus drop.
 * Null when the profile maps no bus for it, or too few members are in the log.
 */
export function busOf(match: MatchView, device: string): CanBus | null {
  const bus = match.profile.canBuses?.find((b) => b.members.some((m) => m.name === device))
  if (!bus) return null
  const present = bus.members.filter((m) => match.has(m.key))
  if (present.length < MIN_BUS_MEMBERS) return null
  const deviceNames = new Set(connectedDevices(match).map((d) => d.name))
  const members = present.map((m) => ({
    ...m,
    drops: match.health(m.key, m.ok, m.name).episodes(isFalse, { touching: watched(match) }),
  }))
  return { name: bus.name, members, reporter: present.find((m) => deviceNames.has(m.name))?.name }
}
