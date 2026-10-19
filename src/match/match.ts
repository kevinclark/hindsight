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
import type { ProfileChoice } from '../profiles/choose.ts'
import { median, valueAt, type Interval, type NumberSeries, type ValueSeries } from './series.ts'

export interface Match {
  fileName: string
  log: WpilogFile
  profile: RobotProfile
  /** How the profile was picked for this log, and anything the student should know about it. */
  profileChoice: ProfileChoice
  /** First and last record time in the log, seconds. */
  logStart: number
  logEnd: number
  enabled: Interval[]
  auto: Interval[]
  teleop: Interval[]
  /**
   * The match as the robot saw it: auto enable (the first one under FMS, if the field was attached), the first teleop
   * enable after it, and the end of the last enabled period that could still belong to the match. Enables earlier
   * (queue, pit) or much later in the same log are outside this window.
   */
  matchStart: number | null
  teleopStart: number | null
  matchEnd: number | null
  fms: boolean
  event: string
  matchLabel: string
  build: { sha: string; branch: string; date: string; dirty: string }
  /** Add this to a log time to get Unix epoch seconds (null if the roboRIO clock was never set). */
  epochOffset: number | null
  /** Driver Station logs for this match (two if the DS app restarted), and where they start and end in log time. */
  ds: DsAttachment[]
  /** Decoded signals, so two rules asking for the same key decode it once. */
  cache: Map<string, NumberSeries | ValueSeries<unknown> | null>
}

export interface DsAttachment { file: DslogFile; fileName: string; startTime: number; endTime: number }

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

export function buildMatch(fileName: string, log: WpilogFile, profile: RobotProfile, profileChoice: ProfileChoice = { how: 'given', note: null, fit: null }): Match {
  const s = profile.signals
  let logStart = Infinity
  let logEnd = -Infinity
  // AdvantageKit logs /Timestamp every cycle, so its first and last records give the log's extent.
  const clock = readNumbers(log, '/Timestamp') ?? readNumbers(log, s.batteryVoltage)
  if (clock && clock.t.length) { logStart = clock.t[0]; logEnd = clock.t[clock.t.length - 1] }
  if (!Number.isFinite(logStart)) { logStart = 0; logEnd = 0 }

  const match: Match = {
    fileName, log, profile, profileChoice, logStart, logEnd,
    enabled: [], auto: [], teleop: [], matchStart: null, teleopStart: null, matchEnd: null,
    fms: false, event: '', matchLabel: '', build: { sha: '', branch: '', date: '', dirty: '' },
    epochOffset: null, ds: [], cache: new Map(),
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
  const fms = num(match, s.fmsAttached)
  match.fms = !!fms && Array.from(fms.v).some((v) => v > 0.5)
  findMatchWindow(match, fms)

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

/**
 * Pick the match out of everything enabled in the log. A log can also hold queue or pit enables before the match
 * and practice after it; those must not move "time left", rest voltage or charge drawn.
 */
function findMatchWindow(match: Match, fms: NumberSeries | null): void {
  const game = match.profile.game
  const fieldAuto = fms ? match.auto.find((iv) => valueAt(fms, iv.start) > 0.5) : undefined
  const start = fieldAuto?.start ?? match.auto[0]?.start ?? match.enabled[0]?.start
  if (start === undefined) return
  match.matchStart = start
  match.teleopStart = match.teleop.find((iv) => iv.start >= start)?.start ?? null
  // Allow 15 s for the disable between auto and teleop and for a late re-enable after a comms loss.
  const latestStart = start + game.autoSeconds + game.teleopSeconds + 15
  const inMatch = match.enabled.filter((iv) => iv.start >= start && iv.start <= latestStart)
  match.matchEnd = inMatch.at(-1)?.end ?? null
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
 * How many seconds of this match a Driver Station log covers (0 if none, or if the roboRIO clock was never set).
 * Only the match window counts: a DS log that overlaps just the minutes after boot belongs to another session.
 */
export function dslogOverlap(match: Match, file: DslogFile): number {
  if (match.epochOffset === null || match.matchStart === null || match.matchEnd === null) return 0
  const startTime = file.startEpochSeconds - match.epochOffset
  const endTime = dslogEndEpoch(file) - match.epochOffset
  return Math.max(0, Math.min(endTime, match.matchEnd) - Math.max(startTime, match.matchStart))
}

export function attachDslog(match: Match, file: DslogFile, fileName: string): void {
  const offset = match.epochOffset ?? 0
  match.ds.push({ file, fileName, startTime: file.startEpochSeconds - offset, endTime: dslogEndEpoch(file) - offset })
  match.ds.sort((a, b) => a.startTime - b.startTime)
}

/** Seconds of the current phase left at time t (auto or teleop), from the game's phase lengths. */
export function matchTimeLeft(match: Match, t: number): { phase: 'auto' | 'teleop' | 'disabled'; secondsLeft: number } {
  const game = match.profile.game
  const autoStart = match.matchStart ?? undefined
  const teleopStart = match.teleopStart ?? undefined
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
