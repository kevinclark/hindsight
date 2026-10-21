/**
 * The log types Hindsight reads. Each is a signal map (where that type of log keeps the signals every robot has) and
 * a key that only that type of log has. To read a new type of log, write its signal map and add it here; a team's
 * profile then spreads the map and fills in what its robot logs.
 */
import { hasEntry, readValues, type WpilogFile } from '../readers/wpilog.ts'
import { ADVANTAGEKIT_SIGNALS } from './advantagekit.ts'
import { DATALOGMANAGER_SIGNALS } from './datalogmanager.ts'
import { DOGLOG_SIGNALS } from './doglog.ts'
import { DRIVER_STATION_SIGNALS } from './driverstation.ts'
import { keysOf } from './sources.ts'
import type { SignalKeys, SignalSources, Source } from './types.ts'

export interface LogFormat {
  name: string
  signals: SignalSources
  /** A key that says a log is of this type (checked in list order: the more specific type first). */
  marker: string
  /**
   * The signals this type of log keeps in the same place on every robot: 'all' of the map, or a list. They don't tell
   * robots apart, so they don't count toward a profile's fit (choose.ts). Only listed names are also exempt from
   * "profile gap" on the Logging tab (coverage.ts): an empty slot in an 'all' map, like a plain log's battery voltage,
   * is a real gap a team can fill. AdvantageKit's other fixed keys count toward fit: 8033's profiles always have.
   */
  sameOnEveryRobot: 'all' | (keyof SignalKeys)[]
  /** Folders where this type of log keeps the roboRIO's own readings: not the robot's motors or devices (builder/). */
  roboRioFolders: string[]
}

export const LOG_FORMATS: LogFormat[] = [
  {
    name: 'AdvantageKit',
    signals: ADVANTAGEKIT_SIGNALS,
    marker: '/DriverStation/Enabled',
    sameOnEveryRobot: [
      'emergencyStop', 'matchTimeLeft', 'autoChoice', 'joystickButtonCounts', 'radioConnected', 'codebase', 'logClock',
      'powerDistributionCurrents', 'powerDistributionVoltage', 'powerDistributionChannels', 'totalCurrent',
      ...(Object.keys(DRIVER_STATION_SIGNALS) as (keyof SignalKeys)[]),
    ],
    roboRioFolders: ['/SystemStats', '/PowerDistribution', '/RadioStatus'],
  },
  {
    name: 'DogLog',
    signals: DOGLOG_SIGNALS,
    marker: '/Robot/DogLog/Options',
    sameOnEveryRobot: 'all',
    roboRioFolders: ['/Robot/SystemStats', '/Robot/RadioStatus'],
  },
  { name: 'WPILib DataLogManager', signals: DATALOGMANAGER_SIGNALS, marker: 'DS:enabled', sameOnEveryRobot: 'all', roboRioFolders: [] },
]

/** True for a key under any log type's roboRIO folders (with or without NetworkTables' "NT:"). */
export function isRoboRioReading(key: string): boolean {
  const path = key.replace(/^NT:/, '')
  return LOG_FORMATS.some((f) => f.roboRioFolders.some((folder) => path === folder || path.startsWith(`${folder}/`)))
}

/** Signal names some log type keeps in the same place on every robot (sameOnEveryRobot lists). */
export const NAMES_SAME_ON_EVERY_ROBOT = new Set(LOG_FORMATS.flatMap((f) => (f.sameOnEveryRobot === 'all' ? [] : f.sameOnEveryRobot)))

/** Every key of the log types whose whole map is the same on every robot. */
export const KEYS_SAME_ON_EVERY_ROBOT = new Set(
  LOG_FORMATS.filter((f) => f.sameOnEveryRobot === 'all').flatMap((f) => Object.values(f.signals)).flatMap(keysOf),
)

/** The first log type whose marker the log has. */
export function formatOf(log: WpilogFile): LogFormat | undefined {
  return LOG_FORMATS.find((f) => hasEntry(log, f.marker))
}

/** The first text value at any of the source's keys, '' when none. */
export function firstText(log: WpilogFile, source: Source): string {
  for (const key of keysOf(source)) {
    const v = readValues<string>(log, key)?.v.find((x) => typeof x === 'string' && x !== '')
    if (v) return v
  }
  return ''
}

/** The code's name for itself and the branch it ran, from the log's own type (no profile needed). */
export function codeIdentity(log: WpilogFile): { codebase: string; branch: string } {
  const signals = (formatOf(log) ?? LOG_FORMATS[0]).signals
  return { codebase: firstText(log, signals.codebase), branch: firstText(log, signals.gitBranch) }
}

/**
 * The log type a profile's signals were drafted from: the one whose map more of them match than any other (a kept
 * profile, too). Undefined on a tie: a guess could hand a profile another type's keys.
 */
export function formatOfSignals(signals: Partial<SignalSources>): LogFormat | undefined {
  const text = (source: unknown) => (source === undefined ? '' : keysOf(source as Source).join())
  const sameKeys = (f: LogFormat) => Object.entries(signals)
    .filter(([name, source]) => text(f.signals[name as keyof SignalSources]) === text(source))
    .length
  const [best, next] = LOG_FORMATS.map((f) => ({ f, n: sameKeys(f) })).sort((a, b) => b.n - a.n)
  return best.n > (next?.n ?? -1) ? best.f : undefined
}
