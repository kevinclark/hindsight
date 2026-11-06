/** Who in a robot profile reports a Connected flag, for the rules and for a profile that maps them as one CAN bus. */
import type { RobotProfile } from './types.ts'

/** Every device with a Connected flag: each motor that has one, then the other devices. */
export function connectedFlags(profile: Pick<RobotProfile, 'motorGroups' | 'otherDevices'>): { name: string; key: string }[] {
  const motors = profile.motorGroups.flatMap((g) => g.motors.flatMap((m) => (m.connected ? [{ name: m.name, key: m.connected }] : [])))
  const others = profile.otherDevices.map((d) => ({ name: d.name, key: d.connected }))
  return [...motors, ...others]
}

/** The profile with every device that reports a Connected flag on one CAN bus, read from this profile's own motors. */
export function onOneBus(name: string, profile: RobotProfile): RobotProfile {
  return { ...profile, canBuses: [{ name, members: connectedFlags(profile) }] }
}
