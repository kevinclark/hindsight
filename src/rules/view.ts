/**
 * What a rule sees: the match, its signals and its devices, in plain words.
 *
 * This file is the "engine" side (like the "dusters" of the Ruby lint dust): it walks the log and hands each rule
 * exactly the thing to judge. Rules should not need anything outside this file and rule.ts.
 *
 *   match.signal('batteryVoltage').lowest(match.enabled)          → { value: 6.28, at: 402.2 }
 *   match.signal('brownedOut').turnsOn()                          → [532.77, 533.1, ...]
 *   motor.supply().episodes(above(48), { longerThan: 0.2 })       → [{ start, end, seconds, peak }, ...]
 *
 * Asking for a signal the log doesn't have stops the rule, and the report lists it under "Not checked". A rule
 * never has to check for missing signals itself.
 */

import { has, matchSeconds, matchTimeLeft, matchWhen, num, phaseAt, values, type Match } from '../match/match.ts'
import { indexAt, makeGrid, median, percentile, resample, type Interval, type NumberSeries, type ValueSeries } from '../match/series.ts'
import type { CurrentLimits, RobotProfile } from '../profiles/types.ts'
import { powerReport, type PowerReport } from '../power/power-report.ts'
import { buildPowerGrid, type PowerGrid } from '../power/battery-model.ts'
import type { Pose2d } from '../readers/wpilog.ts'

/** A stretch of time made of one or more intervals, e.g. "while enabled" or "during auto". */
export type Window = Interval[]

/** Thrown when a rule asks for a signal the log doesn't have. The runner turns it into "Not checked". */
export class MissingSignal extends Error {
  key: string
  constructor(key: string) {
    super(`missing ${key}`)
    this.key = key
  }
}

/** A stretch of time when a signal met a test: when it started and ended, and its extreme values. */
export interface Episode {
  start: number
  end: number
  seconds: number
  /** Largest absolute value during the episode (e.g. the worst current, the worst tilt). */
  peak: number
  lowest: number
  highest: number
}

/** A numeric signal (booleans are 0 and 1). Values hold until the next record: they are never interpolated. */
export class Signal {
  /** A name for plots and messages. */
  label: string
  /** The log key it came from. */
  key: string
  /** The records: times (s) and values. */
  series: NumberSeries
  private logEnd: number

  constructor(label: string, key: string, series: NumberSeries, logEnd: number) {
    this.label = label
    this.key = key
    this.series = series
    this.logEnd = logEnd
  }

  /** The value at time t (NaN before the first record). */
  at(t: number): number {
    const i = indexAt(this.series.t, t)
    return i < 0 ? NaN : this.series.v[i]
  }

  /** The last value logged. */
  last(): number {
    return this.series.v.length ? this.series.v[this.series.v.length - 1] : NaN
  }

  /** Every value recorded inside the window (all of them if no window is given). */
  samples(during?: Window): number[] {
    const out: number[] = []
    for (let i = 0; i < this.series.t.length; i++) if (!during || inside(during, this.series.t[i])) out.push(this.series.v[i])
    return out
  }

  /** The lowest value inside the window, and when. */
  lowest(during?: Window): { value: number; at: number } {
    let best = { value: NaN, at: NaN }
    for (let i = this.firstIndex(during); i < this.series.t.length; i++) {
      if (during && !inside(during, this.series.t[i])) continue
      if (Number.isNaN(best.value) || this.series.v[i] < best.value) best = { value: this.series.v[i], at: this.series.t[i] }
    }
    return best
  }

  /** The highest value inside the window, and when. */
  highest(during?: Window): { value: number; at: number } {
    let best = { value: NaN, at: NaN }
    for (let i = this.firstIndex(during); i < this.series.t.length; i++) {
      if (during && !inside(during, this.series.t[i])) continue
      if (Number.isNaN(best.value) || this.series.v[i] > best.value) best = { value: this.series.v[i], at: this.series.t[i] }
    }
    return best
  }

  median(during?: Window): number {
    return median(this.heldSamples(during))
  }

  percentile(p: number, during?: Window): number {
    return percentile(this.heldSamples(during), p)
  }

  /** Like samples(), but a window with no record inside holds the last value before it (logs record on change). */
  private heldSamples(during?: Window): number[] {
    const out = this.samples(during)
    if (out.length === 0 && during?.length) {
      const held = this.at(during[0].start)
      if (Number.isFinite(held)) out.push(held)
    }
    return out
  }

  /**
   * Every stretch of time the signal passed a test, e.g. episodes(below(7)) or episodes(isFalse).
   * `during` keeps only time inside that window (default: the whole log); `longerThan` drops short blips.
   * Touching stretches are joined, so one long episode never shows up as two.
   */
  episodes(test: (value: number) => boolean, options: { during?: Window; longerThan?: number; touching?: Window } = {}): Episode[] {
    const during = options.during ?? [{ start: -Infinity, end: Infinity }]
    const pieces: Interval[] = []
    for (let i = 0; i < this.series.t.length; i++) {
      if (!test(this.series.v[i])) continue
      const start = this.series.t[i]
      const end = i + 1 < this.series.t.length ? this.series.t[i + 1] : this.logEnd
      for (const w of during) {
        const a = Math.max(start, w.start), b = Math.min(end, w.end)
        if (b > a) pieces.push({ start: a, end: b })
      }
    }
    return join(pieces)
      .filter((iv) => iv.end - iv.start > (options.longerThan ?? 0))
      .filter((iv) => !options.touching || options.touching.some((w) => iv.start < w.end && iv.end > w.start))
      .map((iv) => this.describe(iv))
  }

  /** The times a true/false signal turned true (inside the window, if given). */
  turnsOn(during?: Window): number[] {
    const out: number[] = []
    for (let i = 0; i < this.series.t.length; i++) {
      const before = i === 0 ? 0 : this.series.v[i - 1]
      if (this.series.v[i] > 0.5 && before <= 0.5 && (!during || inside(during, this.series.t[i]))) out.push(this.series.t[i])
    }
    return out
  }

  /** The times a counter went up (inside the window, if given). */
  increases(during?: Window): number[] {
    const out: number[] = []
    for (let i = 1; i < this.series.t.length; i++) {
      if (this.series.v[i] > this.series.v[i - 1] && (!during || inside(during, this.series.t[i]))) out.push(this.series.t[i])
    }
    return out
  }

  /** The value at every time in a grid (from match.grid()), holding the last value between records. */
  onGrid(grid: Float64Array): Float64Array {
    return resample(this.series, grid)
  }

  /** The same signal with every value multiplied, e.g. radians to degrees. */
  times(factor: number, label = this.label): Signal {
    return new Signal(label, this.key, { name: this.series.name, t: this.series.t, v: this.series.v.map((x) => x * factor) }, this.logEnd)
  }

  /** Where to start scanning for a window: its first record (binary search), so short windows are fast. */
  private firstIndex(during?: Window): number {
    if (!during || during.length === 0) return 0
    return Math.max(0, indexAt(this.series.t, Math.min(...during.map((w) => w.start))))
  }

  private describe(iv: Interval): Episode {
    let peak = 0, lowest = Infinity, highest = -Infinity
    const visit = (v: number) => { peak = Math.max(peak, Math.abs(v)); lowest = Math.min(lowest, v); highest = Math.max(highest, v) }
    visit(this.at(iv.start)) // the value held from before the episode counts too
    // Start at the episode (binary search), not at the top of the log: a signal that flickers thousands of times
    // made this quadratic (0.6 s on one log).
    for (let i = Math.max(0, indexAt(this.series.t, iv.start)); i < this.series.t.length && this.series.t[i] < iv.end; i++) {
      if (this.series.t[i] >= iv.start) visit(this.series.v[i])
    }
    return { start: iv.start, end: iv.end, seconds: iv.end - iv.start, peak, lowest, highest }
  }
}

/** A text signal (console output, git info, battery ID). */
export class TextSignal {
  key: string
  series: ValueSeries<string>

  constructor(key: string, series: ValueSeries<string>) {
    this.key = key
    this.series = series
  }

  /** The last non-empty value logged ('' if none). */
  last(): string {
    return this.series.v.filter((x) => x !== '').at(-1) ?? ''
  }

  /** The value at time t ('' before the first record). */
  at(t: number): string {
    const i = indexAt(this.series.t, t)
    return i < 0 ? '' : this.series.v[i]
  }

  /** The first time a value matched the pattern, or null if it never did. */
  firstMatch(pattern: RegExp): number | null {
    const i = this.series.v.findIndex((x) => pattern.test(x))
    return i < 0 ? null : this.series.t[i]
  }
}

/** A pose signal (x and y in meters, rotation in radians). */
export class PoseSignal {
  key: string
  series: ValueSeries<Pose2d>

  constructor(key: string, series: ValueSeries<Pose2d>) {
    this.key = key
    this.series = series
  }

  at(t: number): Pose2d | undefined {
    const i = indexAt(this.series.t, t)
    return i < 0 ? undefined : this.series.v[i]
  }
}

/** One motor controller from the robot profile. */
export interface MotorView {
  name: string
  group: string
  supply(): Signal
  stator(): Signal
  velocity(): Signal
  connected(): Signal
}

/** A motor group from the robot profile (e.g. the four flywheel motors), with its configured current limits. */
export interface GroupView {
  name: string
  motors: MotorView[]
  limits: CurrentLimits
  /** True when the motors follow one control loop and should spin at the same speed. */
  sameLoop: boolean
}

/** Anything with a Connected flag: motors, encoders, the gyro. */
export interface DeviceView {
  name: string
  connected(): Signal
}

export interface CameraView {
  name: string
  acceptedPose(): PoseSignal
  stale(): Signal
  connected(): Signal
}

/** A mechanism that zeroes itself (from the profile's `zeroing` list). */
export interface MechanismView {
  name: string
  /** Position in degrees. */
  position(): Signal
  /** When the console first said the zero completed (null if it never did). */
  zeroDoneAt: number | null
  /** Which way the zero drives (into the hard stop). */
  zeroDirection: 'down' | 'up'
  /** Movement in degrees that counts as "moved". */
  moveDegrees: number
}

/** One alert text the robot code raised, with when it was on. */
export interface AlertView {
  name: string
  text: string
  /** The programmers' type for it. */
  kind: 'error' | 'warning' | 'info'
  group: string
  onsetsInMatch: number[]
  onsetsOutsideMatch: number
  secondsInMatch: number
}

/** Everything a rule can ask about one match. */
export class MatchView {
  /** While the robot was enabled (auto and teleop, including any practice enables in the log). */
  readonly enabled: Window
  readonly auto: Window
  readonly teleop: Window
  /** The match itself: from auto enable to the end of the last enable that belongs to the match. */
  readonly wholeMatch: Window
  readonly autoStart: number | null
  readonly teleopStart: number | null
  readonly matchEnd: number | null
  /** True when the field (FMS) was attached at some point. */
  readonly onField: boolean
  readonly profile: RobotProfile
  /** The underlying match model (src/match/match.ts), for the power model and the runner. */
  readonly raw: Match

  constructor(raw: Match) {
    this.raw = raw
    this.profile = raw.profile
    this.enabled = raw.enabled
    this.auto = raw.auto
    this.teleop = raw.teleop
    this.autoStart = raw.matchStart
    this.teleopStart = raw.teleopStart
    this.matchEnd = raw.matchEnd
    this.wholeMatch = raw.matchStart !== null && raw.matchEnd !== null ? [{ start: raw.matchStart, end: raw.matchEnd }] : []
    this.onField = raw.fms
  }

  /** A numeric signal by its profile name (e.g. 'batteryVoltage') or its log key (e.g. '/Drum/Hood/Voltage'). */
  signal(name: string, label = words(name)): Signal {
    const key = this.keyFor(name)
    if (!has(this.raw, key)) throw new MissingSignal(key)
    return new Signal(label, key, num(this.raw, key)!, this.raw.logEnd)
  }

  /** A text signal by profile name or log key. */
  text(name: string): TextSignal {
    const key = this.keyFor(name)
    if (!has(this.raw, key)) throw new MissingSignal(key)
    return new TextSignal(key, values<string>(this.raw, key)!)
  }

  pose(name: string): PoseSignal {
    const key = this.keyFor(name)
    if (!has(this.raw, key)) throw new MissingSignal(key)
    return new PoseSignal(key, values<Pose2d>(this.raw, key)!)
  }

  /** A signal that logs a list of numbers each time, e.g. a power distribution board's channel currents. */
  lists(name: string): { key: string; t: Float64Array; v: number[][] } {
    const key = this.keyFor(name)
    if (!has(this.raw, key)) throw new MissingSignal(key)
    const s = values<number[]>(this.raw, key)!
    return { key, t: s.t, v: s.v }
  }

  /** True when the log has this signal (for the rare rule that works either way). */
  has(name: string): boolean {
    return has(this.raw, this.keyFor(name))
  }

  /** The first of several possible keys that the log has (the battery tracker's keys moved between versions). */
  firstOf(keys: string[]): string {
    const key = keys.find((k) => has(this.raw, k))
    if (!key) throw new MissingSignal(keys[0])
    return key
  }

  /** Times every `dt` seconds across the match, for comparing signals sample by sample. */
  grid(dt = 0.02): Float64Array {
    return this.autoStart === null || this.matchEnd === null ? new Float64Array(0) : makeGrid(this.autoStart, this.matchEnd, dt)
  }

  /**
   * Call this (then return) when the rule can't check this match, or this motor/camera, and say why. It shows under
   * "Not checked", so an empty report never hides "couldn't look".
   */
  couldNotCheck(reason: string): void {
    this.notes.push({ reason, whole: true })
  }

  /** Call this when the rule checked most of it but not all, and say what it skipped ("partly checked"). */
  checkedOnlyPart(reason: string): void {
    this.notes.push({ reason, whole: false })
  }

  /** What couldNotCheck / checkedOnlyPart said since the runner last cleared them (the runner reads this). */
  notes: { reason: string; whole: boolean }[] = []

  private alertList: AlertView[] | null = null

  /** Every alert text the robot code raised (AdvantageKit Alerts), with when it was on. */
  alerts(): AlertView[] {
    if (!this.alertList) this.alertList = this.readAlerts()
    return this.alertList
  }

  private readAlerts(): AlertView[] {
    const seen = new Map<string, AlertView>()
    const KINDS = [['errors', 'error'], ['warnings', 'warning'], ['infos', 'info']] as const
    const present = this.profile.signals.alertGroups.filter((g) => KINDS.some(([k]) => has(this.raw, `${g}/${k}`)))
    if (present.length === 0) throw new MissingSignal(`${this.profile.signals.alertGroups[0]}/errors`)
    const [start, end] = [this.autoStart ?? Infinity, this.matchEnd ?? -Infinity]
    for (const group of present) {
      for (const [k, kind] of KINDS) {
        const a = values<string[]>(this.raw, `${group}/${k}`)
        if (!a) continue
        for (let i = 0; i < a.t.length; i++) {
          const until = i + 1 < a.t.length ? a.t[i + 1] : this.raw.logEnd
          // Compare names with any changing counter ("It's been 12.3s ...") removed, so a counter isn't a new onset.
          const strip = (text: string) => text.replace(/ It's been .*$/, '')
          const before = new Set((i > 0 ? a.v[i - 1] : []).map(strip))
          for (const text of a.v[i]) {
            const name = strip(text)
            const alert = seen.get(name) ?? { name, text: name, kind, group: group.split('/').pop()!, onsetsInMatch: [], onsetsOutsideMatch: 0, secondsInMatch: 0 }
            if (!before.has(name)) { if (this.inMatch(a.t[i])) alert.onsetsInMatch.push(a.t[i]); else alert.onsetsOutsideMatch++ }
            alert.secondsInMatch += Math.max(0, Math.min(until, end) - Math.max(a.t[i], start))
            seen.set(name, alert)
          }
        }
      }
    }
    return [...seen.values()]
  }

  /** The `seconds` before time t, as a window. */
  before(t: number, seconds: number): Window {
    return [{ start: t - seconds, end: t }]
  }

  between(start: number, end: number): Window {
    return [{ start, end }]
  }

  /** Is time t inside the match? */
  inMatch(t: number): boolean {
    return this.wholeMatch.some((iv) => t >= iv.start && t <= iv.end)
  }

  /** "1:47 into the match (teleop; robot time 532.8 s)": the standard way to say when something happened. */
  when(t: number): string {
    return matchWhen(this.raw, t)
  }

  /** Seconds into the match (from the start of auto) at robot time t, or null when the log has no match. */
  matchSeconds(t: number): number | null {
    return matchSeconds(this.raw, t)
  }


  /** Seconds left in the phase (auto or teleop) at time t. */
  timeLeft(t: number): number {
    return matchTimeLeft(this.raw, t).secondsLeft
  }

  phaseAt(t: number): 'auto' | 'teleop' | 'disabled' {
    return phaseAt(this.raw, t)
  }

  /** The battery model and current totals (see src/power/). Missing motor currents stop the rule. */
  power(): { report: PowerReport; grid: PowerGrid } {
    const grid = buildPowerGrid(this.raw)
    const report = powerReport(this.raw)
    if (!grid || !report) throw new MissingSignal('motor supply currents')
    return { report, grid }
  }

  /** Like power(), but null instead of "not checked" when the log has no motor currents: for extra evidence. */
  powerIfLogged(): { report: PowerReport; grid: PowerGrid } | null {
    const grid = buildPowerGrid(this.raw)
    const report = powerReport(this.raw)
    return grid && report ? { report, grid } : null
  }

  get build() {
    return this.raw.build
  }

  /** False when the robot profile doesn't fit this log (another robot): its robot-specific facts can't be trusted. */
  get profileFits(): boolean {
    return !this.raw.profileChoice.misfit
  }

  get dsLogs() {
    return this.raw.ds
  }

  get epochOffset() {
    return this.raw.epochOffset
  }

  private keyFor(name: string): string {
    if (name.startsWith('/')) return name
    const key = (this.profile.signals as unknown as Record<string, string>)[name]
    if (typeof key !== 'string') throw new Error(`"${name}" is not a signal name in the robot profile (src/profiles/)`)
    return key
  }
}

/** 'batteryVoltage' → 'battery voltage' (for plot legends); a log key stays as it is. */
export function words(name: string): string {
  return name.startsWith('/') ? name : name.replace(/([A-Z])/g, ' $1').toLowerCase()
}

/** Is time t inside any interval of the window? */
export function inside(window: Window, t: number): boolean {
  return window.some((iv) => t >= iv.start && t < iv.end)
}

/** Seconds covered by a window. */
export function lengthOf(window: Window): number {
  return window.reduce((s, iv) => s + Math.max(0, iv.end - iv.start), 0)
}

function join(list: Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const iv of sorted) {
    const last = out.at(-1)
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end)
    else out.push({ ...iv })
  }
  return out
}
