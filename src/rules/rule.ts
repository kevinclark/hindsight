/**
 * How to write a rule. Read this file and one rule (src/rules/power/rest-voltage.ts is the simplest) and you know
 * everything you need. CONTRIBUTING.md walks through adding one.
 *
 * A rule is a description plus one function, `check`, that looks at ONE thing and answers "is something wrong?":
 *
 *   export default rule({
 *     id: 'power/rest-voltage',
 *     title: 'Battery not fully charged',
 *     severity: 'warning',
 *     who: ['pit'],
 *     meaning: 'The battery started the match partly discharged, so it sags sooner and deeper under load.',
 *     causes: [
 *       { id: 'not-charged', cause: "The battery wasn't charged", look: 'the charger cart: was this battery on it?' },
 *       { id: 'worn', cause: 'A worn battery that no longer holds a charge', look: 'Power tab: its resistance' },
 *     ],
 *     nextStep: 'Put a battery reading 12.5 V or more at rest on the robot.',
 *     incident: 'A practice match that started at 12.44 V sagged deeper than the one before it',
 *     check(match) {
 *       if (match.autoStart === null) return           // never enabled: nothing to check
 *       const rest = match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
 *       if (rest >= 12.5) return                       // nothing wrong: return nothing
 *       return { message: `Battery rested at ${volts(rest)}`, at: match.autoStart, plot: { signals: ['batteryVoltage'], unit: 'V' } }
 *     },
 *   })
 *
 * `forEach` says what one thing is. Leave it out to check the whole match once. Set it to 'motor', 'motorGroup',
 * 'device', 'camera', 'mechanism' or 'alert' and `check` runs once for each of those, getting it as its first
 * argument; the report names the thing ("Flywheel follower 16 dropped off CAN"), and a thing whose signals are
 * missing is listed under "Not checked" without stopping the others.
 */

import type { AlertView, CameraView, DeviceView, Episode, GroupView, MatchView, MechanismView, MotorView, Signal } from './view.ts'

/** red = it cost or nearly cost a match; amber = a margin is eroding; grey = context. */
export type Severity = 'error' | 'warning' | 'info'

/** Who acts when a rule fires: the software team (code and config), the pit crew (mechanisms, wiring, batteries), the drive team. */
export type Audience = 'software' | 'pit' | 'drive'

/** What `check` returns when something is wrong. Return nothing (undefined) when all is well. */
export interface Problem {
  /** One line, in plain words, with the numbers: "Battery rested at 12.44 V before auto (want 12.5 V or more)". */
  message: string
  /** When it happened, in log seconds. Leave out for whole-match problems. */
  at?: number | null
  /** The numbers behind it, labelled in plain English: { 'rest voltage (V)': 12.44 }. A value left undefined is left out. */
  evidence?: Record<string, number | string | undefined>
  /** Only when this one problem is more (or less) serious than the rule's usual severity. */
  severity?: Severity
  /** What it is about, if the rule didn't use forEach: "Pitch", "Back_Left". Used to track the issue across matches. */
  about?: string
  /**
   * The number the rule judged, against its threshold, so a session can say how far past the line each match went
   * (a finding that barely crosses every time is weaker than one far past it). The first entry is the one judged;
   * any more are context shown in session summaries, e.g. "median speed vs leader 93–97 %".
   */
  measured?: Measurement[]
  /** What to draw: plot: { signals: [battery], unit: 'V' }. By default 5 s either side of `at`. */
  plot?: PlotRequest
  /**
   * Causes this log points to (their ids), most likely first. The rest follow in the rule's order. Use it when the
   * evidence says which cause fits: "the radio stayed linked, so it's the DS laptop, not the radio".
   */
  likely?: string[]
  /** Causes this log rules out, by id, with the reason in a few words: { radio: 'the radio stayed linked' }. */
  ruledOut?: Record<string, string>
  /** The next step for this log, when the rule's usual one doesn't fit (e.g. the DS log is already loaded). */
  nextStep?: string
}

/** A finding's plot. Only `signals` is needed; the rest are for when the default isn't right. */
export interface PlotRequest {
  /** Profile names, log keys or Signals. Names and keys missing from the log are left off. */
  signals: (string | Signal)[]
  /** The unit label: 'V', 'A', '°'. */
  unit?: string
  /** The window, in log seconds (default: 5 s either side of `at`). */
  from?: number
  to?: number
  /** A horizontal line, e.g. the limit: { value: 7, label: '7 V' }. */
  line?: { value: number; label: string }
  /** Vertical marks at these times. */
  marks?: number[]
}

export interface Measurement {
  label: string
  value: number
  unit: string
  /** The rule's threshold for this number (leave out for context numbers). */
  threshold?: number
}

export type Answer = Problem | Problem[] | undefined | void

interface About {
  /** "<area>/<name>", the same as the file path under src/rules/. */
  id: string
  title: string
  severity: Severity
  who: Audience[]
  /** What it probably means when this fires: one or two sentences a student can act on. */
  meaning: string
  /** What could cause it, most likely first. Each says what to look for, and where (a tab, a part, a file). */
  causes: Cause[]
  /** The one thing to do next. A Problem can replace it for one log (`nextStep`). */
  nextStep: string
  /** Why the rule exists: the failure it catches, and where it was seen or documented. */
  incident: string
  /**
   * The rule only makes sense when the robot profile fits the log (it needs the robot's motors, limits or the game's
   * lengths). Rules with forEach motor, motorGroup, device, camera or mechanism count as this already; set it for a
   * match rule that leans on the profile (e.g. its motor names). When no profile fits a log, these rules are listed as not checked.
   */
  needsProfile?: boolean
  /**
   * A Foresight (live pit check) rule: it judges the robot sitting disabled, so it doesn't run on a match log.
   * `match.pitStretch` is the stretch it checks.
   */
  foresightOnly?: boolean
}

/** One possible cause: what it is, and what to look for and where to confirm or rule it out. */
export interface Cause {
  /** A short name, used by a Problem's `likely` and `ruledOut`: 'radio', 'ds-laptop'. */
  id: string
  cause: string
  look: string
}

export type Rule = About & (
  | { forEach?: 'match'; check: (match: MatchView) => Answer }
  | { forEach: 'motor'; check: (motor: MotorView, match: MatchView) => Answer }
  | { forEach: 'motorGroup'; check: (group: GroupView, match: MatchView) => Answer }
  | { forEach: 'device'; check: (device: DeviceView, match: MatchView) => Answer }
  | { forEach: 'camera'; check: (camera: CameraView, match: MatchView) => Answer }
  | { forEach: 'mechanism'; check: (mechanism: MechanismView, match: MatchView) => Answer }
  | { forEach: 'alert'; check: (alert: AlertView, match: MatchView) => Answer }
)

/** Declare a rule. It only checks the shape (so your editor can help); the runner does the rest. */
export function rule<R extends Rule>(definition: R): R {
  return definition
}

// Tests for signal.episodes(...): read them out loud, e.g. episodes(below(7)) = "stretches below 7".
export const below = (limit: number) => (v: number) => v < limit
export const above = (limit: number) => (v: number) => v > limit
/** Further from zero than the limit, either way: beyond(15) is true for 20 and for −20. */
export const beyond = (limit: number) => (v: number) => Math.abs(v) > limit
export const isTrue = (v: number) => v > 0.5
export const isFalse = (v: number) => v < 0.5

// Plain statistics over a list of numbers, for rules that collect their own: maxOf([3, 7]) is 7.
export { maxOf, median, percentile } from '../match/series.ts'

// Formatting numbers for messages, so every rule says them the same way.
export const volts = (v: number) => `${v.toFixed(2)} V`
export const amps = (a: number) => `${a.toFixed(0)} A`
export const secs = (s: number) => `${s.toFixed(1)} s`
export const pct = (fraction: number) => `${(100 * fraction).toFixed(1)} %`
export const round = (x: number, digits = 2) => +x.toFixed(digits)
/** A count with its noun: plural(1, 'time') is "1 time", plural(3, 'time') is "3 times". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** How long a list of episodes lasted, added up (s). */
export const totalSeconds = (episodes: Episode[]) => episodes.reduce((sum, e) => sum + e.seconds, 0)
