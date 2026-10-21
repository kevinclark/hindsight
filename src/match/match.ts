/**
 * The match model: one robot log plus everything rules need to know about the match it holds.
 *
 * - phases: when the robot was enabled, and whether in auto or teleop (from /DriverStation/Enabled + /Autonomous,
 *   or DS:enabled + DS:autonomous in a plain WPILib log)
 * - event and match number (from /DriverStation/*, or NT:/FMSInfo/*; see profiles/datalogmanager.ts)
 * - one log key per profile signal: the first of its sources this match's logs have (profiles/sources.ts), the
 *   Driver Station log's fields (dslog:brownout) included
 * - the code build (from /RealMetadata/*)
 * - the wall clock, so a Driver Station log can be lined up with the robot log
 */

import type { LimitLines } from '../code/limit-lines.ts'
import { hasEntry, readNumbers, readValues, type WpilogFile } from '../readers/wpilog.ts'
import { dslogEndEpoch, type DslogFile, type DslogRecord } from '../readers/dslog.ts'
import type { ResolvedProfile, RobotProfile } from '../profiles/types.ts'
import type { ProfileChoice } from '../profiles/choose.ts'
import { withNtAlertGroups } from '../profiles/datalogmanager.ts'
import { DSLOG, isDslogKey, resolveBattery, resolveSignals } from '../profiles/sources.ts'
import { median, valueAt, type Interval, type NumberSeries, type ValueSeries } from './series.ts'

export interface Match {
  fileName: string
  log: WpilogFile
  /** The profile with one log key per signal, picked for this match's logs (see `sources`). */
  profile: ResolvedProfile
  /** The profile as written: every place each key may be, so a Driver Station log loaded later is used. */
  sources: RobotProfile
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
  /**
   * The other robot logs loaded with this one (empty when it was loaded alone): the other pieces of a match the robot
   * program restarted in, and earlier matches (e.g. earlier runs of the same auto).
   */
  others: Match[]
  /** Decoded signals, so two rules asking for the same key decode it once. */
  cache: Map<string, NumberSeries | ValueSeries<unknown> | null>
  /** Set only by Foresight (the live pit check): the disabled stretch being checked. See src/foresight/engine.ts. */
  foresight?: ForesightWindow
  /**
   * Set only when a robot-code folder was given and the log ran another commit than the profile's: per motor group,
   * whether its current-limit lines match the profile's commit (src/code/limit-lines.ts).
   */
  limitLines?: Map<string, LimitLines>
}

/** The disabled stretch Foresight checks: from start-up settling (or the last disable) to now, in robot time. */
export interface ForesightWindow {
  start: number
  end: number
  /** The code (GitSHA) of the last pit check that came out GO before this one, if any. */
  lastPassingSha: string | null
  /** The stretch in words, for counts ("dropped out 2 times since start-up settled"). */
  words?: string
}

export interface DsAttachment { file: DslogFile; fileName: string; startTime: number; endTime: number }

/** A numeric signal from the log, or a Driver Station log field (dslog:brownout); null if missing. Decoded once. */
export function num(match: Match, key: string): NumberSeries | null {
  if (match.cache.has(key)) return match.cache.get(key) as NumberSeries | null
  match.cache.set(key, isDslogKey(key) ? dslogSeries(match, key) : readNumbers(match.log, key))
  return match.cache.get(key) as NumberSeries | null
}

/**
 * A Driver Station log field on the robot's clock: the records where the DS saw the robot, inside this robot log
 * (a DS log kept open across a reboot also holds the earlier boot). Null without a DS log or a set roboRIO clock.
 */
function dslogSeries(match: Match, key: string): NumberSeries | null {
  const offset = match.epochOffset
  if (offset === null) return null
  const field = key.slice(DSLOG.length) as keyof DslogRecord
  const records = match.ds.flatMap((d) => d.file.records)
  if (records.length === 0 || !(field in records[0])) return null // no DS log, or no such field
  const points = records
    .filter((r) => r.voltage !== null)
    .map((r) => ({ t: r.epochSeconds - offset, v: Number(r[field]) }))
    .filter((p) => p.t >= match.logStart && p.t <= match.logEnd)
    .sort((a, b) => a.t - b.t)
  if (points.length === 0) return null
  return { name: key, t: Float64Array.from(points, (p) => p.t), v: Float64Array.from(points, (p) => p.v) }
}

/** Any signal as plain values (strings, arrays, structs). Null if missing. */
export function values<T>(match: Match, key: string): ValueSeries<T> | null {
  const cacheKey = `values:${key}`
  if (!match.cache.has(cacheKey)) match.cache.set(cacheKey, readValues(match.log, key))
  return match.cache.get(cacheKey) as ValueSeries<T> | null
}

/** True when the log (or, for a dslog: key, a Driver Station log) has the key with at least one record. */
export function has(match: Match, key: string): boolean {
  return isDslogKey(key) ? num(match, key) !== null : hasEntry(match.log, key)
}

/** The first key in the list that the log has, or null. */
export function firstPresent(match: Match, keys: string[]): string | null {
  return keys.find((k) => has(match, k)) ?? null
}

const MATCH_TYPES = ['', 'Practice', 'Qualification', 'Elimination']

export function buildMatch(fileName: string, log: WpilogFile, givenProfile: RobotProfile, profileChoice: ProfileChoice = { how: 'given', note: null, fit: null }): Match {
  // No Driver Station log yet: attachDslog picks again.
  const resolved = resolveProfile(givenProfile, (key) => hasEntry(log, key))
  const profile = withNtAlertGroups(log, resolved)
  const s = profile.signals
  let logStart = Infinity
  let logEnd = -Infinity
  // A key logged every loop (AdvantageKit's /Timestamp) gives the log's extent; otherwise the battery voltage, or
  // the first and last record of any kind.
  const clock = readNumbers(log, s.logClock) ?? readNumbers(log, s.batteryVoltage)
  if (clock && clock.t.length) { logStart = clock.t[0]; logEnd = clock.t[clock.t.length - 1] }
  if (!Number.isFinite(logStart)) { logStart = log.firstTime; logEnd = log.lastTime }

  const match: Match = {
    fileName, log, profile, sources: givenProfile, profileChoice, logStart, logEnd,
    enabled: [], auto: [], teleop: [], matchStart: null, teleopStart: null, matchEnd: null,
    fms: false, event: '', matchLabel: '', build: { sha: '', branch: '', date: '', dirty: '' },
    epochOffset: null, ds: [], others: [], cache: new Map(),
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
  if (profileChoice.misfit) {
    // The profile is for another robot or game: find the match with generous lengths, then measure the real ones.
    match.profile = { ...profile, game: { name: 'measured from this log', autoSeconds: 20, teleopSeconds: 150 } }
    findMatchWindow(match, fms)
    match.profile = { ...profile, game: measuredGame(match) }
  }
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

/**
 * On the field, teleop starts this long after auto ends: 3.0 s in 8033's 12 FMS matches (2025 game, 2026 offseason),
 * 4.0 s in three official 2026 event logs (teams 340 and 3602).
 */
const FIELD_AUTO_TO_TELEOP_SECONDS = 3
const FIELD_AUTO_TO_TELEOP_MAX_SECONDS = 4.5

/**
 * Auto and teleop lengths from the log itself, for a log no profile fits, rounded to whole seconds. On the field, an
 * auto period that ran until the pause before teleop is the auto length; a robot disabled earlier doesn't shorten it,
 * so then auto is the time from auto start to teleop start less the 3 s pause. Off the field, the first auto period.
 * Teleop runs from the teleop enable to the end of the match.
 */
function measuredGame(match: Match): RobotProfile['game'] {
  const auto = match.auto.find((iv) => match.matchStart !== null && iv.start >= match.matchStart)
  const ranToTheEnd = auto && match.teleopStart !== null && match.teleopStart - auto.end <= FIELD_AUTO_TO_TELEOP_MAX_SECONDS
  const autoSeconds = match.fms && !ranToTheEnd && match.matchStart !== null && match.teleopStart !== null && match.teleopStart > match.matchStart
    ? Math.round(match.teleopStart - match.matchStart - FIELD_AUTO_TO_TELEOP_SECONDS)
    : auto ? Math.round(auto.end - auto.start) : 15
  // Teleop: the enable that starts it, plus re-enables within 15 s (a comms loss), so a practice enable long after the
  // match doesn't stretch it.
  let teleopEnd: number | null = null
  for (const iv of match.enabled) {
    if (match.teleopStart === null || iv.end <= match.teleopStart) continue
    if (teleopEnd === null) { if (iv.start <= match.teleopStart + 0.5) teleopEnd = iv.end; continue }
    if (iv.start - teleopEnd > 15) break
    teleopEnd = iv.end
  }
  const teleopSeconds = match.teleopStart !== null && teleopEnd !== null ? Math.round(teleopEnd - match.teleopStart) : 135
  return { name: 'measured from this log', autoSeconds, teleopSeconds }
}

const EPOCH_2001_US = 978307200e6

/** Median of (wall clock − log time) over records logged after the roboRIO clock was set. */
function computeEpochOffset(match: Match): number | null {
  const s = match.profile.signals
  const epoch = num(match, s.epochMicros)
  if (!epoch || epoch.t.length === 0) return null
  const valid = num(match, s.systemTimeValid)
  const validFrom = valid ? (Array.from(valid.t).find((_, i) => valid.v[i] > 0.5) ?? Infinity) : -Infinity
  const offsets: number[] = []
  for (let i = 0; i < epoch.t.length; i++) {
    // Before 2001 is a clock that was never set (a log with no SystemTimeValid flag to say so).
    if (epoch.t[i] >= validFrom && epoch.v[i] > EPOCH_2001_US) offsets.push(epoch.v[i] / 1e6 - epoch.t[i])
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

/** Add a Driver Station log, and pick each signal's source again: a signal the robot log lacks may be in it. */
export function attachDslog(match: Match, file: DslogFile, fileName: string): void {
  const offset = match.epochOffset ?? 0
  match.ds.push({ file, fileName, startTime: file.startEpochSeconds - offset, endTime: dslogEndEpoch(file) - offset })
  match.ds.sort((a, b) => a.startTime - b.startTime)
  // Every series from a DS log, and the power model built on the old picks, are out of date.
  for (const key of match.cache.keys()) if (isDslogKey(key) || key.startsWith('power:')) match.cache.delete(key)
  const { signals, battery } = resolveProfile(match.sources, (key) => has(match, key))
  match.profile = { ...match.profile, battery, signals: { ...signals, alertGroups: match.profile.signals.alertGroups } }
}

/** The profile with one key per signal and battery key: the first of its sources that `present` says the logs have. */
function resolveProfile(profile: RobotProfile, present: (key: string) => boolean): ResolvedProfile {
  return { ...profile, signals: resolveSignals(profile.signals, present), battery: resolveBattery(profile.battery, present) }
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

/** Seconds into the match (from the start of auto) at robot time t, or null when the log has no match in it. */
export function matchSeconds(match: Match, t: number): number | null {
  return match.matchStart === null ? null : t - match.matchStart
}

/** 107 → "1:47". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * When something happened, match time first (what people think in), robot time in parentheses (what the log and
 * AdvantageScope show): "1:47 into the match (teleop; robot time 532.8 s)".
 */
export function matchWhen(match: Match, t: number): string {
  const robot = `robot time ${t.toFixed(1)} s`
  const s = matchSeconds(match, t)
  if (s === null) return robot
  if (s < 0) return `before the match (${robot})`
  if (match.matchEnd !== null && t > match.matchEnd + 0.5) return `after the match (${robot})`
  return `${clock(s)} into the match (${phaseAt(match, t)}; ${robot})`
}

/**
 * matchWhen for the middle of a sentence: "at 1:47 into the match (...)", but "before the match (...)" and
 * "after the match (...)" with no "at" (never "at before the match").
 */
export function matchWhenAt(match: Match, t: number): string {
  const when = matchWhen(match, t)
  return when.startsWith('before the match') || when.startsWith('after the match') ? when : `at ${when}`
}

/** Phase name at time t, for evidence text. */
export function phaseAt(match: Match, t: number): 'auto' | 'teleop' | 'disabled' {
  if (match.auto.some((iv) => t >= iv.start && t < iv.end)) return 'auto'
  if (match.teleop.some((iv) => t >= iv.start && t < iv.end)) return 'teleop'
  return 'disabled'
}
