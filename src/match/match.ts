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
import { dslogEndEpoch, type DslogFile } from '../readers/dslog.ts'
import type { ResolvedProfile, RobotProfile } from '../profiles/types.ts'
import type { ProfileChoice } from '../profiles/choose.ts'
import { withNtAlertGroups } from '../profiles/datalogmanager.ts'
import { isOtherLogKey, resolveBattery, resolveSignals } from '../profiles/sources.ts'
import { dseventsEndEpoch, MATCH_TYPES, type DseventsFile } from '../readers/dsevents.ts'
import { otherLogSeries } from './other-logs.ts'
import { median, valueAt, type Interval, type NumberSeries, type ValueSeries } from './series.ts'
import { playedAt } from './played-at.ts'
import { gameFor } from '../profiles/games.ts'

/**
 * One run (ADR 8): a maximal stretch of enabled time whose disabled gaps are shorter than RUN_JOIN_SECONDS. `auto` is
 * true when the run began in autonomous. On the field the FMS match is one run; off it, every run counts.
 */
export interface Run { start: number; end: number; auto: boolean }

/**
 * Enabled stretches closer than this are one run. Measured on 975 gaps between consecutive enabled stretches in 627
 * off-field logs of one library: no clear valley (2 s: 1424 runs, 3 s: 1365, 4.5 s: 1325, 6 s: 1272), so the 3 s
 * the plan started from stays. Gaps under 3 s are 97 of 975 (the quick disable and re-enable).
 */
export const RUN_JOIN_SECONDS = 3

/** A run shorter than this is checked for faults only (ADR 8): about the shortest a margin or a rate can be read from. */
export const SHORT_RUN_SECONDS = 10

/** The runs among enabled stretches (sorted by start): a gap of RUN_JOIN_SECONDS or more starts a new one. */
export function runsOf(enabled: Interval[], auto: Interval[], joinSeconds = RUN_JOIN_SECONDS): Run[] {
  const runs: Run[] = []
  for (const iv of enabled) {
    const last = runs.at(-1)
    if (last && iv.start - last.end < joinSeconds) last.end = Math.max(last.end, iv.end)
    else runs.push({ start: iv.start, end: iv.end, auto: auto.some((a) => a.start === iv.start) })
  }
  return runs
}

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
   * (queue, pit) or much later in the same log are outside this window. Off the field there is no match: the window is
   * every run, first enable to the end of the last one (see `runs`).
   */
  matchStart: number | null
  teleopStart: number | null
  matchEnd: number | null
  /** The runs in the log, in time order. On the field the FMS match is one of them (the one that counts as the match); off it every run is judged. */
  runs: Run[]
  fms: boolean
  event: string
  matchLabel: string
  build: { sha: string; branch: string; date: string; dirty: string }
  /** Add this to a log time to get Unix epoch seconds (null if the roboRIO clock was never set). */
  epochOffset: number | null
  /** Driver Station logs for this match (two if the DS app restarted), and where they start and end in log time. */
  ds: DsAttachment[]
  /** Driver Station event logs (.dsevents) for this match. */
  dsEvents: { file: DseventsFile; fileName: string }[]
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
  const fromOtherLog = otherLogSeries(match, key)
  match.cache.set(key, fromOtherLog === undefined ? readNumbers(match.log, key) : fromOtherLog)
  return match.cache.get(key) as NumberSeries | null
}

/** Any signal as plain values (strings, arrays, structs). Null if missing. */
export function values<T>(match: Match, key: string): ValueSeries<T> | null {
  const cacheKey = `values:${key}`
  if (!match.cache.has(cacheKey)) match.cache.set(cacheKey, readValues(match.log, key))
  return match.cache.get(cacheKey) as ValueSeries<T> | null
}

/** True when the log (or, for a dslog: key, a Driver Station log) has the key with at least one record. */
export function has(match: Match, key: string): boolean {
  return isOtherLogKey(key) ? num(match, key) !== null : hasEntry(match.log, key)
}

/** The first key in the list that the log has, or null. */
export function firstPresent(match: Match, keys: string[]): string | null {
  return keys.find((k) => has(match, k)) ?? null
}


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
    enabled: [], auto: [], teleop: [], matchStart: null, teleopStart: null, matchEnd: null, runs: [],
    fms: false, event: '', matchLabel: '', build: { sha: '', branch: '', date: '', dirty: '' },
    epochOffset: null, ds: [], dsEvents: [], others: [], cache: new Map(),
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
  // The clock doesn't depend on the match window, and the misfit case below needs the date.
  match.epochOffset = computeEpochOffset(match)
  if (profileChoice.misfit) {
    // The profile is for another robot or game, so its game may not be this log's: use the season's game by the log's
    // date (profiles/games.ts). With no date, find the match with generous lengths, then measure the real ones.
    const when = playedAt(match).playedAt
    const season = when === null ? null : gameFor(when)
    if (season) {
      const { name, autoSeconds, teleopSeconds } = season.game
      match.profile = { ...profile, game: { name, autoSeconds, teleopSeconds } }
    } else {
      match.profile = { ...profile, game: { name: 'measured from this log', autoSeconds: 20, teleopSeconds: 150 } }
      findMatchWindow(match, fms)
      match.profile = { ...profile, game: measuredGame(match) }
    }
  }
  findMatchWindow(match, fms)

  readIdentity(match)
  match.build = {
    sha: lastString(match, s.gitSha), branch: lastString(match, s.gitBranch), date: lastString(match, s.gitDate),
    dirty: lastString(match, s.gitDirty),
  }
  return match
}

const lastString = (match: Match, key: string) => {
  const v = values<string>(match, key)
  return v ? (v.v.filter((x) => typeof x === 'string' && x !== '').at(-1) ?? '') : ''
}

const lastNumber = (match: Match, key: string) => {
  const v = num(match, key)
  return v && v.v.length ? v.v[v.v.length - 1] : 0
}

/** The event and match the logs say this was ("Qualification 28"), from the profile's identity signals. */
function readIdentity(match: Match): void {
  const s = match.profile.signals
  match.event = lastString(match, s.eventName)
  const typeNumber = lastNumber(match, s.matchType)
  const type = typeNumber > 0 ? MATCH_TYPES[typeNumber] ?? '' : ''
  const number = lastNumber(match, s.matchNumber)
  match.matchLabel = type && number ? `${type} ${number}` : ''
}

/**
 * Pick the match out of everything enabled in the log. A log can also hold queue or pit enables before the match
 * and practice after it; those must not move "time left", rest voltage or charge drawn.
 */
function findMatchWindow(match: Match, fms: NumberSeries | null): void {
  const game = match.profile.game
  match.runs = []
  if (!match.fms) {
    // Off the field there is no match to find: every run is judged, from the first enable to the end of the last.
    const first = match.enabled[0]
    if (!first) return
    match.matchStart = first.start
    match.teleopStart = match.teleop.find((iv) => iv.start >= first.start)?.start ?? null
    match.matchEnd = match.enabled.at(-1)!.end
    match.runs = runsOf(match.enabled, match.auto)
    return
  }
  const fieldAuto = fms ? match.auto.find((iv) => valueAt(fms, iv.start) > 0.5) : undefined
  const start = fieldAuto?.start ?? match.auto[0]?.start ?? match.enabled[0]?.start
  if (start === undefined) return
  match.matchStart = start
  match.teleopStart = match.teleop.find((iv) => iv.start >= start)?.start ?? null
  // Allow 15 s for the disable between auto and teleop and for a late re-enable after a comms loss.
  const latestStart = start + game.autoSeconds + game.teleopSeconds + 15
  const inMatch = match.enabled.filter((iv) => iv.start >= start && iv.start <= latestStart)
  match.matchEnd = inMatch.at(-1)?.end ?? null
  // The FMS match is one run; enables outside it (queue, pit, practice after) are runs of their own.
  const end = match.matchEnd ?? start
  const outside = match.enabled.filter((iv) => iv.end <= start || iv.start > end)
  const others = runsOf(outside, match.auto)
  match.runs = [...others.filter((r) => r.end <= start), { start, end, auto: match.auto.some((a) => a.start === start) }, ...others.filter((r) => r.end > start)]
}

/**
 * On the field, teleop starts this long after auto ends: 3.0 s in 8033's 12 FMS matches (2025 game, 2026 offseason),
 * 4.0 s in three official 2026 event logs (teams 340 and 3602).
 */
const FIELD_AUTO_TO_TELEOP_SECONDS = 3
const FIELD_AUTO_TO_TELEOP_MAX_SECONDS = 4.5

/**
 * Auto and teleop lengths from the log itself, for a log no profile fits that has no date (or predates the first game
 * listed), rounded to whole seconds. On the field, an auto period that ran until the pause before teleop is the auto length; a robot disabled earlier doesn't shorten it,
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
  return overlap(match, file.startEpochSeconds, dslogEndEpoch(file))
}

function overlap(match: Match, startEpoch: number, endEpoch: number): number {
  if (match.epochOffset === null || match.matchStart === null || match.matchEnd === null) return 0
  const startTime = startEpoch - match.epochOffset
  const endTime = endEpoch - match.epochOffset
  return Math.max(0, Math.min(endTime, match.matchEnd) - Math.max(startTime, match.matchStart))
}

/** Add a Driver Station log, and pick each signal's source again: a signal the robot log lacks may be in it. */
export function attachDslog(match: Match, file: DslogFile, fileName: string): void {
  const offset = match.epochOffset ?? 0
  match.ds.push({ file, fileName, startTime: file.startEpochSeconds - offset, endTime: dslogEndEpoch(file) - offset })
  match.ds.sort((a, b) => a.startTime - b.startTime)
  pickSourcesAgain(match)
}

/** Add a Driver Station event log, likewise. */
export function attachDsevents(match: Match, file: DseventsFile, fileName: string): void {
  match.dsEvents.push({ file, fileName })
  pickSourcesAgain(match)
}

/** How many seconds of this match a Driver Station event log covers (as dslogOverlap). */
export function dseventsOverlap(match: Match, file: DseventsFile): number {
  return overlap(match, file.startEpochSeconds, dseventsEndEpoch(file))
}

/** After a Driver Station file is added: each signal's source and the match identity, picked again. */
function pickSourcesAgain(match: Match): void {
  // Every series from another log, and the power model built on the old picks, are out of date.
  for (const key of match.cache.keys()) if (isOtherLogKey(key) || key.startsWith('power:')) match.cache.delete(key)
  const { signals, battery } = resolveProfile(match.sources, (key) => has(match, key))
  match.profile = { ...match.profile, battery, signals: { ...signals, alertGroups: match.profile.signals.alertGroups } }
  readIdentity(match)
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

/**
 * The run that holds time t, numbered from 1, and how many runs there are; off the field only. A time in a gap belongs to
 * the run before it (`inside` is false then), a time before the first run to none.
 */
export function runAt(match: Match, t: number): { n: number; of: number; run: Run; inside: boolean } | null {
  if (match.fms || !match.runs?.length) return null
  let at = -1
  match.runs.forEach((r, i) => { if (r.start <= t) at = i })
  if (at < 0) return null
  const run = match.runs[at]
  return { n: at + 1, of: match.runs.length, run, inside: t <= run.end }
}

/**
 * Seconds into the match (from the start of auto) at robot time t, or null when the log has no match in it. Off the field
 * it is seconds into the run that holds t.
 */
export function matchSeconds(match: Match, t: number): number | null {
  if (match.matchStart === null) return null
  const run = runAt(match, t)
  return t - (run ? run.run.start : match.matchStart)
}

/** 107 → "1:47". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * When something happened, match time first (what people think in), robot time in parentheses (what the log and
 * AdvantageScope show): "1:47 into the match (teleop; robot time 532.8 s)". Off the field the time is in a run:
 * "0:12 into run 3 of 7 (teleop; robot time 532.8 s)".
 */
export function matchWhen(match: Match, t: number): string {
  const robot = `robot time ${t.toFixed(1)} s`
  const s = matchSeconds(match, t)
  if (s === null) return robot
  // A log with a single run reads as before: the one run is the whole window.
  if (!match.fms && match.runs?.length > 1) {
    const r = runAt(match, t)
    if (!r) return `before the first run (${robot})`
    if (r.inside) return `${clock(s)} into run ${r.n} of ${r.of} (${phaseAt(match, t)}; ${robot})`
    if (r.n === r.of) return `after the last run (${robot})`
    return `between run ${r.n} and run ${r.n + 1} of ${r.of} (${robot})`
  }
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
  return /^(before|after|between) /.test(when) ? when : `at ${when}`
}

/** Phase name at time t, for evidence text. */
export function phaseAt(match: Match, t: number): 'auto' | 'teleop' | 'disabled' {
  if (match.auto.some((iv) => t >= iv.start && t < iv.end)) return 'auto'
  if (match.teleop.some((iv) => t >= iv.start && t < iv.end)) return 'teleop'
  return 'disabled'
}
