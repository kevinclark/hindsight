import { openWpilog, readRaw } from '../../src/readers/wpilog.ts'
import { AFTER_DISABLE_SECONDS } from '../../src/foresight/engine.ts'

/**
 * Robot time from which the pit check graded after the log's last enable can show: that disable plus the engine's
 * battery-recovery wait. Null when the log never enables (the first verdict is then the only one). A log this can't
 * time (no Enabled entry, ends enabled, or ends before the check) is refused, so a replay never shows the wrong check.
 * For scripts that replay a log as the robot's NT4 stream (nt4-replay-server.ts) and wait for Foresight's verdict.
 */
export function checkAfterLastEnable(bytes: Uint8Array, name: string): { first: number; at: number | null; last: number } {
  const log = openWpilog(bytes)
  const raw = readRaw(log, '/DriverStation/Enabled')
  if (!raw) throw new Error(`${name} has no /DriverStation/Enabled entry, so the check after its last enable can't be timed`)
  let on = false
  let disabledAt: number | null = null
  raw.t.forEach((t, i) => { const now = raw.payload[i][0] !== 0; if (on && !now) disabledAt = t; on = now })
  if (on) throw new Error(`${name} ends with the robot enabled, so the replay never shows a check after its last enable`)
  const at = disabledAt === null ? null : disabledAt + AFTER_DISABLE_SECONDS
  if (at !== null && at > log.lastTime) throw new Error(`${name} ends ${(at - log.lastTime).toFixed(1)} s before the check after its last enable can show`)
  return { first: log.firstTime, at, last: log.lastTime }
}
