/**
 * Which NetworkTables topics Foresight subscribes to, and how they map to log keys.
 *
 * AdvantageKit publishes every logged value under /AdvantageKit: the log key /DriverStation/Enabled is the topic
 * /AdvantageKit/DriverStation/Enabled. Foresight subscribes only to the keys its checks read for the chosen robot
 * profile (a few dozen of the ~455 the robot publishes), never the whole tree.
 */
import type { RobotProfile } from '../profiles/types.ts'

export const AK_PREFIX = '/AdvantageKit'

/** Log key → topic. */
export const topicFor = (key: string) => `${AK_PREFIX}${key}`

/** Topic → log key (null for a topic outside /AdvantageKit, e.g. WPILib's own /FMSInfo). */
export function keyFor(topic: string): string | null {
  return topic.startsWith(`${AK_PREFIX}/`) ? topic.slice(AK_PREFIX.length) : null
}

/**
 * The field guard's topics. Either one saying the field (FMS) is attached closes the connection for good:
 *   - AdvantageKit's /DriverStation/FMSAttached (boolean);
 *   - WPILib's own /FMSInfo/FMSControlData (int; bit 4 = FMS attached), which every WPILib robot publishes.
 */
export const GUARD_FMS_ATTACHED = topicFor('/DriverStation/FMSAttached')
export const GUARD_CONTROL_DATA = '/FMSInfo/FMSControlData'
export const FMS_ATTACHED_BIT = 16

/** What the robot says about itself, read first so the right profile can be chosen. */
export const METADATA_KEYS = ['/RealMetadata/Codebase', '/RealMetadata/GitBranch', '/RealMetadata/GitSHA', '/RealMetadata/GitDirty', '/RealMetadata/GitDate']

/** Every log key Foresight's checks read for this robot profile. */
export function foresightKeys(profile: RobotProfile): string[] {
  const s = profile.signals
  const keys = [
    '/Timestamp',
    ...METADATA_KEYS,
    s.enabled, s.autonomous, s.fmsAttached, s.dsAttached,
    s.gitSha, s.gitBranch, s.gitDate, s.gitDirty,
    s.batteryVoltage,
    ...s.alertGroups.flatMap((g) => [`${g}/errors`, `${g}/warnings`, `${g}/infos`]),
    ...Object.values(profile.battery).flat(),
    ...profile.motorGroups.flatMap((g) => g.motors.map((m) => m.connected)),
    ...profile.otherDevices.map((d) => d.connected),
    ...profile.cameras.flatMap((c) => [c.connected, c.stale]),
  ]
  const fp = profile.foresight
  if (fp) {
    keys.push(fp.gyroYaw)
    for (let port = 0; port < fp.controllers; port++) keys.push(`/DriverStation/Joystick${port}/Name`)
    for (const z of fp.zeroChecks) if (!('notCheckable' in z)) keys.push(z.absolute, z.motor)
  }
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && k !== ''))]
}

/** NetworkTables type → .wpilog type (null for a type Foresight doesn't read). */
export function wpilogType(ntType: string): string | null {
  switch (ntType) {
    case 'boolean': case 'double': case 'float': case 'string': case 'json': case 'raw':
    case 'boolean[]': case 'double[]': case 'float[]': case 'string[]': case 'structschema':
      return ntType
    case 'int': return 'int64'
    case 'int[]': return 'int64[]'
  }
  return ntType.startsWith('struct:') ? ntType : null
}
