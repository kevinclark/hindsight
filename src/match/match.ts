/**
 * The match model: one robot log plus everything rules need to know about the match it holds.
 *
 * - phases: when the robot was enabled, and whether in auto or teleop (from /DriverStation/Enabled + /Autonomous)
 * - event and match number (from /DriverStation/*)
 * - the code build (from /RealMetadata/*)
 * - the wall clock, so a Driver Station log can be lined up with the robot log
 */

import { hasEntry, readNumbers, readValues, type WpilogFile } from '../readers/wpilog.ts'
import { dslogEndEpoch, type DslogFile } from '../readers/dslog.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { median, valueAt, type Interval, type NumberSeries, type ValueSeries } from './series.ts'

export interface Match {
  fileName: string
  log: WpilogFile
  profile: RobotProfile
  /** First and last record time in the log, seconds. */
  logStart: number
  logEnd: number
  enabled: Interval[]
  auto: Interval[]
  teleop: Interval[]
  /** First auto enable, and the end of the last enabled period: the match as the robot saw it. */
  matchStart: number | null
  matchEnd: number | null
  fms: boolean
  event: string
  matchLabel: string
  build: { sha: string; branch: string; date: string; dirty: string }
  /** Add this to a log time to get Unix epoch seconds (null if the roboRIO clock was never set). */
  epochOffset: number | null
  /** Optional Driver Station log for the same match, and how it lines up. */
  ds: { file: DslogFile; fileName: string; startTime: number; endTime: number } | null
  /** Decoded signals, so two rules asking for the same key decode it once. */
  cache: Map<string, NumberSeries | ValueSeries<unknown> | null>
}

/** A numeric signal from the log (null if missing). Decoded once per match. */
export function num(match: Match, key: string): NumberSeries | null {
  if (!match.cache.has(key)) match.cache.set(key, readNumbers(match.log, key))
  return match.cache.get(key) as NumberSeries | null
}

/** Any signal as plain values (strings, arrays, structs). Null if missing. */
export function values<T>(match: Match, key: string): ValueSeries<T> | null {
  const cacheKey = `values:${key}`
  if (!match.cache.has(cacheKey)) match.cache.set(cacheKey, readValues(match.log, key))
  return match.cache.get(cacheKey) as ValueSeries<T> | null
}

/** True when the log has the key with at least one record. */
export function has(match: Match, key: string): boolean {
  return hasEntry(match.log, key)
}

/** The first key in the list that the log has, or null. */
export function firstPresent(match: Match, keys: string[]): string | null {
  return keys.find((k) => has(match, k)) ?? null
}

const MATCH_TYPES = ['', 'Practice', 'Qualification', 'Elimination']

export function buildMatch(fileName: string, log: WpilogFile, profile: RobotProfile): Match {
  const s = profile.signals
  let logStart = Infinity
  let logEnd = -Infinity
  // AdvantageKit logs /Timestamp every cycle, so its first and last records give the log's extent.
  const clock = readNumbers(log, '/Timestamp') ?? readNumbers(log, s.batteryVoltage)
  if (clock && clock.t.length) { logStart = clock.t[0]; logEnd = clock.t[clock.t.length - 1] }
  if (!Number.isFinite(logStart)) { logStart = 0; logEnd = 0 }

  const match: Match = {
    fileName, log, profile, logStart, logEnd,
    enabled: [], auto: [], teleop: [], matchStart: null, matchEnd: null,
    fms: false, event: '', matchLabel: '', build: { sha: '', branch: '', date: '', dirty: '' },
    epochOffset: null, ds: null, cache: new Map(),
  }

  // Phases: walk the change points of Enabled and Autonomous together.
  const enabled = num(match, s.enabled)
  const autonomous = num(match, s.autonomous)
  if (enabled) {
    const times = new Set<number>([...enabled.t, ...(autonomous?.t ?? [])])
    const sorted = [...times].sort((a, b) => a - b)
    let current: { kind: 'auto' | 'teleop'; start: number } | null = null
    const close = (t: number) => {
      if (!current) return
      const iv = { start: current.start, end: t }
      if (iv.end > iv.start) (current.kind === 'auto' ? match.auto : match.teleop).push(iv)
      current = null
    }
    for (const t of sorted) {
      const en = valueAt(enabled, t) > 0.5
      const au = autonomous ? valueAt(autonomous, t) > 0.5 : false
      const kind = au ? 'auto' : 'teleop'
      if (current && (!en || current.kind !== kind)) close(t)
      if (en && !current) current = { kind, start: t }
    }
    close(logEnd)
    match.enabled = [...match.auto, ...match.teleop].sort((a, b) => a.start - b.start)
  }
  match.matchStart = match.auto[0]?.start ?? match.enabled[0]?.start ?? null
  match.matchEnd = match.enabled.at(-1)?.end ?? null

  const fms = num(match, s.fmsAttached)
  match.fms = !!fms && Array.from(fms.v).some((v) => v > 0.5)

  const lastString = (key: string) => {
    const v = values<string>(match, key)
    return v ? (v.v.filter((x) => typeof x === 'string' && x !== '').at(-1) ?? '') : ''
  }
  const lastNumber = (key: string) => {
    const v = num(match, key)
    return v && v.v.length ? v.v[v.v.length - 1] : 0
  }
  match.event = lastString(s.eventName)
  const type = MATCH_TYPES[lastNumber(s.matchType)] ?? ''
  const number = lastNumber(s.matchNumber)
  match.matchLabel = type && number ? `${type} ${number}` : ''
  match.build = {
    sha: lastString(s.gitSha), branch: lastString(s.gitBranch), date: lastString(s.gitDate), dirty: lastString(s.gitDirty),
  }
  match.epochOffset = computeEpochOffset(match)
  return match
}

/** Median of (wall clock − log time) over records logged after the roboRIO clock was set. */
function computeEpochOffset(match: Match): number | null {
  const s = match.profile.signals
  const epoch = num(match, s.epochMicros)
  if (!epoch || epoch.t.length === 0) return null
  const valid = num(match, s.systemTimeValid)
  const validFrom = valid ? (Array.from(valid.t).find((_, i) => valid.v[i] > 0.5) ?? Infinity) : -Infinity
  const offsets: number[] = []
  for (let i = 0; i < epoch.t.length; i++) {
    if (epoch.t[i] >= validFrom) offsets.push(epoch.v[i] / 1e6 - epoch.t[i])
  }
  return offsets.length ? median(offsets) : null
}

/**
 * Attach a Driver Station log if it overlaps this match in wall-clock time. Returns false (and attaches nothing)
 * when the two don't overlap, so a DS log from a different match can't produce findings here.
 */
export function attachDslog(match: Match, file: DslogFile, fileName: string): boolean {
  if (match.epochOffset === null) return false
  const startTime = file.startEpochSeconds - match.epochOffset
  const endTime = dslogEndEpoch(file) - match.epochOffset
  if (endTime < match.logStart || startTime > match.logEnd) return false
  match.ds = { file, fileName, startTime, endTime }
  return true
}

/** Seconds of the current phase left at time t (auto or teleop), from the game's phase lengths. */
export function matchTimeLeft(match: Match, t: number): { phase: 'auto' | 'teleop' | 'disabled'; secondsLeft: number } {
  const game = match.profile.game
  const autoStart = match.auto[0]?.start
  const teleopStart = match.teleop[0]?.start
  if (teleopStart !== undefined && t >= teleopStart) return { phase: 'teleop', secondsLeft: game.teleopSeconds - (t - teleopStart) }
  if (autoStart !== undefined && t >= autoStart) return { phase: 'auto', secondsLeft: game.autoSeconds - (t - autoStart) }
  return { phase: 'disabled', secondsLeft: NaN }
}

/** Phase name at time t, for evidence text. */
export function phaseAt(match: Match, t: number): 'auto' | 'teleop' | 'disabled' {
  if (match.auto.some((iv) => t >= iv.start && t < iv.end)) return 'auto'
  if (match.teleop.some((iv) => t >= iv.start && t < iv.end)) return 'teleop'
  return 'disabled'
}
