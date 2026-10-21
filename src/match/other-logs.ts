/**
 * Series from the Driver Station's own files, on the robot's clock (profiles/sources.ts OTHER_LOGS names them):
 * `dslog:<field>`, a field of the DS log's records, and `dsevents:<fact>`, a fact from its event log (DSEVENTS_FACTS).
 * Both keep only what falls inside this robot log: the DS keeps its files open across robot reboots.
 */
import type { DslogRecord } from '../readers/dslog.ts'
import { brownoutCounts, canivorePorts, fmsMatches, KERNEL_EVENTS, kernelLines, type DseventsFile, type KernelLine } from '../readers/dsevents.ts'
import { DSEVENTS, DSLOG } from '../profiles/sources.ts'
import type { Match } from './match.ts'
import type { NumberSeries } from './series.ts'

type Point = { t: number; v: number }

/** What a fact needs: the event logs, and this robot log's extent and wall clock (epoch = robot time + offset). */
interface Clock { files: DseventsFile[]; offset: number; logStart: number; logEnd: number }

/**
 * The facts a profile can name as `dsevents:<fact>`, each its points on the robot's clock. To read a new fact, add it
 * here and name it in profiles/driverstation.ts.
 */
export const DSEVENTS_FACTS = {
  /** The DS's running brownout count, counted from this robot log's start. */
  brownoutCount: (c: Clock) => countsFromLogStart(c),
  /** What the FMS said this match was, held for the whole log. */
  matchType: (c: Clock) => fmsPoint(c, 'type'),
  matchNumber: (c: Clock) => fmsPoint(c, 'number'),
  replayNumber: (c: Clock) => fmsPoint(c, 'replay'),
  /** Running counts of kernel lines (readers/dsevents.ts KERNEL_EVENTS), from 0 at the log's start. */
  canivoreUsbDisconnects: (c: Clock) => kernelEventCounts(c, KERNEL_EVENTS.canivoreUsbDisconnects),
  canivoreTxFails: (c: Clock) => kernelEventCounts(c, KERNEL_EVENTS.canivoreTxFails),
  usbPortDisabled: (c: Clock) => kernelEventCounts(c, KERNEL_EVENTS.usbPortDisabled),
} satisfies Record<string, (c: Clock) => Point[]>

export type DseventsFact = keyof typeof DSEVENTS_FACTS

/** The series behind a Driver Station key, or undefined for a robot-log key. Null when the file or fact isn't there. */
export function otherLogSeries(match: Match, key: string): NumberSeries | null | undefined {
  if (key.startsWith(DSLOG)) return dslogSeries(match, key.slice(DSLOG.length) as keyof DslogRecord)
  if (key.startsWith(DSEVENTS)) return dseventsSeries(match, key.slice(DSEVENTS.length))
  return undefined
}

/** A field of the DS log's records where the DS saw the robot. Null without a DS log or a set roboRIO clock. */
function dslogSeries(match: Match, field: keyof DslogRecord): NumberSeries | null {
  const offset = match.epochOffset
  if (offset === null) return null
  const records = match.ds.flatMap((d) => d.file.records)
  if (records.length === 0 || !(field in records[0])) return null // no DS log, or no such field
  const points = records
    .filter((r) => r.voltage !== null)
    .map((r) => ({ t: r.epochSeconds - offset, v: Number(r[field]) }))
    .filter((p) => p.t >= match.logStart && p.t <= match.logEnd)
    .sort((a, b) => a.t - b.t)
  return series(`${DSLOG}${field}`, points)
}

function dseventsSeries(match: Match, fact: string): NumberSeries | null {
  const offset = match.epochOffset
  if (offset === null || match.dsEvents.length === 0 || !Object.hasOwn(DSEVENTS_FACTS, fact)) return null
  const clock = { files: match.dsEvents.map((d) => d.file), offset, logStart: match.logStart, logEnd: match.logEnd }
  return series(`${DSEVENTS}${fact}`, DSEVENTS_FACTS[fact as DseventsFact](clock))
}

function series(name: string, points: Point[]): NumberSeries | null {
  if (points.length === 0) return null
  return { name, t: Float64Array.from(points, (p) => p.t), v: Float64Array.from(points, (p) => p.v) }
}

const robotTime = (c: Clock, epochSeconds: number) => epochSeconds - c.offset
const inLog = (c: Clock, t: number) => t >= c.logStart && t <= c.logEnd

/** The DS's count inside the log, less what it had counted before the log began (an earlier match or boot). */
function countsFromLogStart(c: Clock): Point[] {
  const counts = c.files.flatMap(brownoutCounts).map((x) => ({ t: robotTime(c, x.epochSeconds), v: x.count }))
  const before = counts.filter((p) => p.t < c.logStart).at(-1)?.v ?? 0
  return counts.filter((p) => inLog(c, p.t)).map((p) => ({ t: p.t, v: p.v - before }))
}

/**
 * The FMS's last word on this match before the log ended (a DS left open across matches logs one per match). None
 * before then (a pit log in a day-long event log): no identity, rather than a later match's.
 */
function fmsPoint(c: Clock, field: 'type' | 'number' | 'replay'): Point[] {
  const latest = c.files.flatMap(fmsMatches).filter((m) => robotTime(c, m.epochSeconds) <= c.logEnd).at(-1)
  return latest ? [{ t: c.logStart, v: latest[field] }] : []
}

/** Gaps between when the DS logged a line and its uptime that differ by less than this belong to one boot. */
const ONE_BOOT_SPREAD_SECONDS = 2 // measured: 1.0 s and 1.3 s spreads within one boot (334's E6, E3); a boot is ~30 s+

/**
 * A running count of the kernel lines that pass `test`, from 0 at the log's start. A kernel line carries the
 * roboRIO's uptime; the DS logs it some time later (0–1.3 s seen). Uptime and robot time differ by one constant per
 * boot (38 s in 334's E6). The DS also re-sends old lines later (34.7 s later in E3), and after a reboot those would be
 * another boot's, so the constant comes from the largest group of gaps within 2 s of each other, and is that group's
 * smallest gap (the least-delayed line). Events outside the log are dropped.
 */
function kernelEventCounts(c: Clock, test: (line: KernelLine, ports: Set<string>) => boolean): Point[] {
  const lines = c.files.flatMap(kernelLines)
  const thisLog = lines.filter((l) => inLog(c, robotTime(c, l.epochSeconds)))
  const uptimeToRobot = oneBootGap(thisLog.map((l) => robotTime(c, l.epochSeconds) - l.uptime))
  const start = { t: c.logStart, v: 0 }
  if (uptimeToRobot === null) return [start]
  const ports = canivorePorts(lines)
  const times = thisLog.filter((l) => test(l, ports)).map((l) => l.uptime + uptimeToRobot).filter((t) => inLog(c, t))
  return [start, ...times.sort((a, b) => a - b).map((t, i) => ({ t, v: i + 1 }))]
}

/** The smallest gap of the largest group of gaps within ONE_BOOT_SPREAD_SECONDS of each other; null with none. */
function oneBootGap(gaps: number[]): number | null {
  const sorted = [...gaps].sort((a, b) => a - b)
  let best = { from: 0, count: 0 }
  for (let from = 0, to = 0; from < sorted.length; from++) {
    while (to < sorted.length && sorted[to] - sorted[from] <= ONE_BOOT_SPREAD_SECONDS) to++
    if (to - from > best.count) best = { from, count: to - from }
  }
  return best.count ? sorted[best.from] : null
}
