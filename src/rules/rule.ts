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
 *     fix: 'Put a charged battery on the robot.',
 *     incident: 'CalGames 2026 Q21 started at 12.44 V',
 *     check(match) {
 *       if (match.autoStart === null) return           // never enabled: nothing to check
 *       const rest = match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
 *       if (rest >= 12.5) return                       // nothing wrong: return nothing
 *       return { message: `Battery rested at ${volts(rest)}`, at: match.autoStart }
 *     },
 *   })
 *
 * `forEach` says what one thing is. Leave it out to check the whole match once. Set it to 'motor', 'motorGroup',
 * 'device', 'camera', 'mechanism' or 'alert' and `check` runs once for each of those, getting it as its first
 * argument; the report names the thing ("Flywheel follower 16 dropped off CAN"), and a thing whose signals are
 * missing is listed under "Not checked" without stopping the others.
 */

import type { AlertView, CameraView, DeviceView, GroupView, MatchView, MechanismView, MotorView, Signal } from './view.ts'

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
  /** The numbers behind it, labelled in plain English: { 'rest voltage (V)': 12.44 }. */
  evidence?: Record<string, number | string>
  /** Only when this one problem is more (or less) serious than the rule's usual severity. */
  severity?: Severity
  /** What it is about, if the rule didn't use forEach: "Pitch", "Back_Left". Used to track the issue across matches. */
  about?: string
  /** Signals to draw around `at`: profile names, log keys or Signals. */
  plot?: (string | Signal)[]
  /** The plot's unit label: 'V', 'A', '°'. */
  plotUnit?: string
  /** Plot window and extras, when the default (5 s either side of `at`) isn't right. */
  plotFrom?: number
  plotTo?: number
  plotLine?: { value: number; label: string }
  plotMarks?: number[]
}

export type Answer = Problem | Problem[] | undefined | void

interface About {
  /** "<area>/<name>", the same as the file path under src/rules/. */
  id: string
  title: string
  severity: Severity
  who: Audience[]
  /** What to do when it fires. Shown under every finding. */
  fix: string
  /** The incident that taught us this rule. */
  incident: string
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

// Formatting numbers for messages, so every rule says them the same way.
export const volts = (v: number) => `${v.toFixed(2)} V`
export const amps = (a: number) => `${a.toFixed(0)} A`
export const secs = (s: number) => `${s.toFixed(1)} s`
export const pct = (fraction: number) => `${(100 * fraction).toFixed(1)} %`
export const round = (x: number, digits = 2) => +x.toFixed(digits)
