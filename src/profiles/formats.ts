/**
 * The log types Hindsight reads. Each is a signal map (where that type of log keeps the signals every robot has) and
 * a key that only that type of log has. To read a new type of log, write its signal map and add it here; a team's
 * profile then spreads the map and fills in what its robot logs.
 */
import { ADVANTAGEKIT_SIGNALS } from './advantagekit.ts'
import { DATALOGMANAGER_SIGNALS } from './datalogmanager.ts'
import { DOGLOG_SIGNALS } from './doglog.ts'
import type { SignalSources } from './types.ts'

export interface LogFormat {
  name: string
  signals: SignalSources
  /** A key that says a log is of this type (checked in list order: the more specific type first). */
  marker: string
  /**
   * True when every log of this type has the map's keys, whatever the robot: they then don't count toward a
   * profile's fit (profiles/choose.ts). AdvantageKit's do count: 8033's profiles have always been fitted with them.
   */
  sharedByEveryRobot: boolean
}

export const LOG_FORMATS: LogFormat[] = [
  { name: 'AdvantageKit', signals: ADVANTAGEKIT_SIGNALS, marker: '/DriverStation/Enabled', sharedByEveryRobot: false },
  { name: 'DogLog', signals: DOGLOG_SIGNALS, marker: '/Robot/DogLog/Options', sharedByEveryRobot: true },
  { name: 'WPILib DataLogManager', signals: DATALOGMANAGER_SIGNALS, marker: 'DS:enabled', sharedByEveryRobot: true },
]

/** The log type a profile's signals were drafted from: the one whose map most of them match (a kept profile, too). */
export function formatOfSignals(signals: Partial<SignalSources>): LogFormat | undefined {
  const same = (f: LogFormat) => Object.entries(signals).filter(([name, source]) => JSON.stringify(f.signals[name as keyof SignalSources]) === JSON.stringify(source)).length
  return [...LOG_FORMATS].sort((a, b) => same(b) - same(a))[0]
}
