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

/**
 * Where the robot's log is going, from the Hindsight companion library (companion/keys.json). The same keys on every
 * robot that uses it, so they are not in the profile; a robot without the companion never sends them, and the check
 * that reads them says "not checked".
 */
export const LOG_DRIVE_KEYS = {
  onUsb: '/Hindsight/LogDrive/OnUsb',
  status: '/Hindsight/LogDrive/Status',
  path: '/Hindsight/LogDrive/Path',
  device: '/Hindsight/LogDrive/Device',
} as const

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
    ...profile.motorGroups.flatMap((g) => g.motors.flatMap((m) => [m.connected, m.temperature, m.updating])),
    ...profile.otherDevices.flatMap((d) => [d.connected, d.updating]),
    ...profile.cameras.flatMap((c) => [c.connected, c.stale, c.acceptedPose, c.result]),
    ...Object.values(LOG_DRIVE_KEYS),
  ]
  const fp = profile.foresight
  if (fp) {
    keys.push(fp.gyroYaw)
    keys.push(...fp.controllerNames)
    for (const z of fp.zeroChecks) if (!('notCheckable' in z)) keys.push(z.absolute, z.motor)
  }
  return [...new Set(keys.filter((k): k is string => typeof k === 'string' && k !== ''))]
}

/** How long the fast "updating" readings are kept: foresight/values-updating needs 5 s, its plot 10 s. */
export const RECENT_SECONDS = 30

/**
 * Signals only the last RECENT_SECONDS of matter for: each device's "updating" reading (a motor's stator current
 * changes ~45 times a second at rest; 15 of them were 4/5 of the records a check wrote, 33 → ~240 ms per check).
 */
export function recentKeys(profile: RobotProfile): string[] {
  const keys = [...profile.motorGroups.flatMap((g) => g.motors.map((m) => m.updating)), ...profile.otherDevices.map((d) => d.updating)]
  return [...new Set(keys.filter((k): k is string => !!k))]
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
  // proto: (e.g. PhotonVision's pipeline result) arrives as bytes and is kept as is, like a struct.
  return ntType.startsWith('struct:') || ntType.startsWith('proto:') ? ntType : null
}
