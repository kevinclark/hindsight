/** Invented logs for the library tests: event TEST, no real match, no names. */
import { writeDslog, writeDsevents, writeWpilog, type FixtureEntry } from './fixture-format.ts'

export interface RobotLogOptions {
  /** Wall clock at log time 0, ms. Omit for a robot whose clock was never set. */
  clockMs?: number
  /** Log time the match is enabled for; omit for a log that was never enabled. */
  enabled?: [start: number, end: number]
  event?: string
  matchType?: number
  matchNumber?: number
  fms?: boolean
  battery?: string
  /** The code's name for itself (/RealMetadata/Codebase) and the branch it ran. */
  codebase?: string
  branch?: string
  /** The roboRIO's serial (/SystemStats/SerialNumber) and the robot's own edition (/RealMetadata/Robot Edition). */
  roboRio?: string
  edition?: string
  /** Makes two otherwise equal logs differ. */
  seed?: string
}

export function robotLog(o: RobotLogOptions = {}): Uint8Array {
  const entries: FixtureEntry[] = [{ name: '/Test/Seed', type: 'string', records: [[0, o.seed ?? 'a']] }]
  if (o.enabled) {
    entries.push(
      { name: '/DriverStation/Enabled', type: 'boolean', records: [[o.enabled[0] - 5, false], [o.enabled[0], true], [o.enabled[1], false]] },
      { name: '/DriverStation/Autonomous', type: 'boolean', records: [[o.enabled[0] - 5, true], [o.enabled[1], false]] },
    )
  }
  if (o.fms) entries.push({ name: '/DriverStation/FMSAttached', type: 'boolean', records: [[0, true]] })
  if (o.event) entries.push({ name: '/DriverStation/EventName', type: 'string', records: [[0, o.event]] })
  if (o.matchType !== undefined) entries.push({ name: '/DriverStation/MatchType', type: 'int64', records: [[0, o.matchType]] })
  if (o.matchNumber !== undefined) entries.push({ name: '/DriverStation/MatchNumber', type: 'int64', records: [[0, o.matchNumber]] })
  if (o.battery) entries.push({ name: '/RealOutputs/Battery/Id', type: 'string', records: [[0, o.battery]] })
  if (o.codebase) entries.push({ name: '/RealMetadata/Codebase', type: 'string', records: [[0, o.codebase]] })
  if (o.branch) entries.push({ name: '/RealMetadata/GitBranch', type: 'string', records: [[0, o.branch]] })
  if (o.roboRio) entries.push({ name: '/SystemStats/SerialNumber', type: 'string', records: [[0, ''], [1, o.roboRio]] })
  if (o.edition) entries.push({ name: '/RealMetadata/Robot Edition', type: 'string', records: [[0, o.edition]] })
  if (o.clockMs !== undefined) {
    entries.push(
      { name: '/SystemStats/SystemTimeValid', type: 'boolean', records: [[0, true]] },
      { name: '/SystemStats/EpochTimeMicros', type: 'int64', records: [[0, o.clockMs * 1000], [60, (o.clockMs + 60e3) * 1000]] },
    )
  }
  return writeWpilog(entries)
}

/** A Driver Station log covering [startSeconds, +seconds) of wall clock. */
export function dsLog(startEpochSeconds: number, seconds: number): Uint8Array {
  return writeDslog({ name: 'ds', startEpochSeconds, count: seconds * 50, noRobotFrom: seconds * 50, robotFrom: 0 })
}

export function dsEvents(startEpochSeconds: number, seconds: number): Uint8Array {
  return writeDsevents(startEpochSeconds, [[startEpochSeconds + seconds, 'test message']])
}
