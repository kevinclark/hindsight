/**
 * What sim-run plays against the robot: the built-in scenarios every robot gets (start up and enable twice, every
 * auto on both alliances, drive forward on both alliances) and the team's own, from its scenario file
 * (docs/sim-run.md). Each scenario becomes one run per alliance, and each run a timeline of lines for the harness:
 * "<seconds after start> <action> <arguments>".
 */

import type { Chooser, Mode } from './events.ts'

export type Station = 'Red1' | 'Red2' | 'Red3' | 'Blue1' | 'Blue2' | 'Blue3'

/** Expectations a team writes on a press: each checked from the moment the input was pressed. */
export type Expectation =
  | { message: string; within: number }
  | { finish: true; within: number }
  | { key: string; becomes: string | number | boolean; within: number }

export interface Press {
  /** "#p3": marks the timeline line, so the run says when the robot got the input. */
  marker: string
  at: number
  /** As the team wrote it: "driver b". */
  said: string
  down: string
  up: string
  holdFor: number | null
  expect: Expectation[]
}

export interface Step { mode: Mode; seconds: number; presses: Press[] }

export interface Zero {
  name: string
  done: RegExp
  /** The zero should run once per robot program start, not on every enable. */
  once: boolean
  /** Named in the team's file (the team says it should happen), not only in the Hindsight robot profile. */
  fromFile: boolean
}

export interface Scenario {
  name: string
  kind: 'startup' | 'auto' | 'drive' | 'team'
  steps: Step[]
  alliances: Station[]
  /** An auto run: the chooser option it selects, or null for a robot with no chooser. Undefined for other kinds. */
  auto?: { chooser: string; option: string; isDefault: boolean } | null
}

export interface Run {
  scenario: Scenario
  alliance: Station
  /** "Auto "Left Trench" (red)", as the report names the run. */
  label: string
  timeline: string[]
  seconds: number
}

export interface TeamFile {
  zeroes: Zero[]
  scenarios: Scenario[]
  autos: { chooser: string | null; alliances: Station[]; skip: string[] }
  /** The stick input that drives forward, or null when the team turned the drive check off. */
  forward: { said: string; down: string; up: string } | null
}

const XBOX_BUTTONS: Record<string, number> = {
  a: 1, b: 2, x: 3, y: 4, leftBumper: 5, rightBumper: 6, back: 7, start: 8, leftStick: 9, rightStick: 10,
}
const XBOX_AXES: Record<string, number> = { leftX: 0, leftY: 1, leftTrigger: 2, rightTrigger: 3, rightX: 4, rightY: 5 }
const POV: Record<string, number> = { povUp: 0, povRight: 90, povDown: 180, povLeft: 270 }
const MODES: Mode[] = ['disabled', 'auto', 'teleop', 'test']
const PRESS_FIELDS = new Set(['at', 'for', 'value', 'expect'])
const INPUT_NAMES = [...Object.keys(XBOX_BUTTONS), ...Object.keys(XBOX_AXES), ...Object.keys(POV)]

/** Measured (probe, 2026-10-21): the robot is ready 2–2.5 s after start; choosers are read just before the first enable. */
const FIRST_DISABLED_SECONDS = 3
const DEFAULT_AUTO_SECONDS = 15

// ---- The team's file ---------------------------------------------------------------------------------------------

/** Reads a team's scenario file (JSON). Throws an error that says what to fix, and where. */
export function readTeamFile(text: string, fileName: string): TeamFile {
  const raw = JSON.parse(text) as Record<string, any>
  const file: FileContext = { fileName, controllers: { driver: 0, operator: 1, ...raw.controllers }, presses: 0 }
  const scenarios: Scenario[] = (raw.scenarios ?? []).map((s: any, i: number) => ({
    name: s.name ?? `scenario ${i + 1}`,
    kind: 'team',
    steps: (s.steps ?? []).map((st: any, j: number) => readStep(st, file, `scenario "${s.name ?? i + 1}", step ${j + 1}`)),
    alliances: stations(s.alliances ?? [s.alliance ?? 'blue1'], file),
  }))
  return {
    zeroes: (raw.zeroes ?? []).map((z: any, i: number) => readZero(z, file, `zero ${i + 1}`)),
    scenarios,
    autos: {
      chooser: raw.autos?.chooser ?? null,
      alliances: stations(raw.autos?.alliances ?? ['blue1', 'red1'], file),
      skip: raw.autos?.skip ?? [],
    },
    forward: raw.drive === false ? null : readForward(raw.drive?.forward ?? { driver: 'leftY', value: -1 }, file),
  }
}

/** What reading a file needs to say where a mistake is, and to number its presses. */
interface FileContext { fileName: string; controllers: Record<string, number>; presses: number }

function fail(file: FileContext, what: string): never {
  throw new Error(`${file.fileName}: ${what}`)
}

/** One step: `{ "teleop": 5, "press": [...] }`. */
function readStep(s: Record<string, any>, file: FileContext, at: string): Step {
  const mode = MODES.find((m) => typeof s[m] === 'number')
  if (!mode || !(s[mode] > 0)) fail(file, `${at} needs a mode and its seconds, like { "teleop": 5 }`)
  const seconds = s[mode]
  const presses: Press[] = (s.press ?? []).map((p: any, i: number) => readPress(p, file, `${at}, press ${i + 1}`))
  // A press timed past its step would be played after the step's release, or after the run's end.
  const late = presses.find((p) => p.at >= seconds)
  if (late) fail(file, `${at}: a press at ${late.at} s is outside this ${seconds} s step`)
  return { mode, seconds, presses }
}

/** One zero: `{ "name": "hood", "done": "Rezeroed hood", "once": true }`. */
function readZero(z: Record<string, any>, file: FileContext, at: string): Zero {
  if (typeof z.name !== 'string' || typeof z.done !== 'string' || !z.done) {
    fail(file, `${at} needs "name" and "done" (the text your code prints when the zero is done)`)
  }
  return { name: z.name, done: new RegExp(z.done), once: z.once === true, fromFile: true }
}

/** One press: `{ "at": 1, "driver": "b", "for": 2, "expect": [...] }`. */
function readPress(p: Record<string, any>, file: FileContext, at: string): Press {
  const controller = Object.keys(p).filter((k) => !PRESS_FIELDS.has(k))
  if (controller.length !== 1 || file.controllers[controller[0]] === undefined) {
    fail(file, `${at} needs one controller (${Object.keys(file.controllers).join(', ')}), like { "at": 1, "driver": "b" }`)
  }
  const input = String(p[controller[0]])
  const lines = inputLines(file.controllers[controller[0]], input, p.value)
  if (!lines) fail(file, `${at}: "${input}" is not an Xbox input (${INPUT_NAMES.join(', ')})`)
  file.presses++
  return {
    marker: `#p${file.presses}`,
    at: seconds(p.at ?? 0, file, `${at}, "at"`),
    said: `${controller[0]} ${input}`,
    ...lines,
    holdFor: p.for === undefined ? null : seconds(p.for, file, `${at}, "for"`),
    expect: (p.expect ?? []).map((e: any) => readExpectation(e, file, `${at}, expect`)),
  }
}

function readExpectation(e: Record<string, any>, file: FileContext, at: string): Expectation {
  const within = seconds(e.within, file, `${at}, "within"`)
  if (typeof e.message === 'string') return { message: e.message, within }
  if (e.finish === true) return { finish: true, within }
  if (typeof e.key === 'string' && e.becomes !== undefined) return { key: e.key, becomes: e.becomes, within }
  fail(file, `${at}: each expectation is { "message": ... }, { "finish": true } or { "key": ..., "becomes": ... }, with "within"`)
}

/** A number of seconds (0 or more), or a failure that says where. */
function seconds(value: unknown, file: FileContext, at: string): number {
  if (typeof value !== 'number' || !(value >= 0)) fail(file, `${at} must be a number of seconds, 0 or more`)
  return value
}

/** The drive check's forward input: `{ "driver": "leftY", "value": -1 }`. */
function readForward(f: Record<string, any>, file: FileContext): TeamFile['forward'] {
  const [controller, input] = Object.entries(f).find(([k]) => k !== 'value') ?? fail(file, '"drive": { "forward": ... } needs a controller')
  const lines = inputLines(file.controllers[controller], String(input), f.value ?? -1)
  if (!lines) fail(file, `"drive": "${input}" on "${controller}" is not an Xbox input on a named controller`)
  return { said: `${controller} ${input}`, ...lines }
}

/** A file-less team: built-in scenarios only. */
export const NO_TEAM_FILE: TeamFile = readTeamFile('{}', '(none)')

function stations(names: string[], file: FileContext): Station[] {
  return names.map((n) => {
    const s = /^(red|blue)([123])$/i.exec(n)
    if (!s) fail(file, `"${n}" is not a driver station (red1..red3, blue1..blue3)`)
    return `${s[1][0].toUpperCase()}${s[1].slice(1).toLowerCase()}${s[2]}` as Station
  })
}

/** The harness lines that press and release an Xbox input on a port, or null for a name that isn't one. */
function inputLines(port: number | undefined, input: string, value: number | undefined): { down: string; up: string } | null {
  if (port === undefined) return null
  if (XBOX_BUTTONS[input]) return { down: `button ${port} ${XBOX_BUTTONS[input]} 1`, up: `button ${port} ${XBOX_BUTTONS[input]} 0` }
  if (XBOX_AXES[input] !== undefined) return { down: `axis ${port} ${XBOX_AXES[input]} ${value ?? 1}`, up: `axis ${port} ${XBOX_AXES[input]} 0` }
  if (POV[input] !== undefined) return { down: `pov ${port} ${POV[input]}`, up: `pov ${port} -1` }
  return null
}

// ---- Built-in scenarios ------------------------------------------------------------------------------------------

/** Start up, then enable twice: crashes at start, and whether each zero runs on every enable. */
export const STARTUP: Scenario = {
  name: 'Start up and enable twice',
  kind: 'startup',
  steps: [disabled(FIRST_DISABLED_SECONDS), teleop(5), disabled(2), teleop(5), disabled(1)],
  alliances: ['Blue1'],
}

/**
 * Each auto in the chooser, alone on a freshly started robot, on each alliance. With no chooser, one auto: whatever
 * the robot code runs when auto starts.
 */
export function autoScenarios(chooser: Chooser | null, team: TeamFile, autoSeconds = DEFAULT_AUTO_SECONDS): Scenario[] {
  const steps: Step[] = [disabled(FIRST_DISABLED_SECONDS), { mode: 'auto', seconds: autoSeconds, presses: [] }, disabled(1)]
  if (!chooser) return [{ name: 'Auto (the robot has no auto chooser)', kind: 'auto', steps, alliances: team.autos.alliances, auto: null }]
  return chooser.options.filter((o) => !team.autos.skip.includes(o)).map((option) => ({
    name: `Auto "${option}"`,
    kind: 'auto',
    steps,
    alliances: team.autos.alliances,
    auto: { chooser: chooser.key, option, isDefault: option === chooser.defaultOption },
  }))
}

/** Teleop, the drive stick pushed forward for 1.5 s, on each alliance: forward should drive away from your station. */
export function driveScenario(team: TeamFile): Scenario | null {
  if (!team.forward) return null
  const forward: Press = { marker: '#forward', at: 1, said: team.forward.said, down: team.forward.down, up: team.forward.up, holdFor: 1.5, expect: [] }
  return { name: `Drive forward (${team.forward.said})`, kind: 'drive', steps: [disabled(FIRST_DISABLED_SECONDS), { mode: 'teleop', seconds: 4, presses: [forward] }, disabled(1)], alliances: team.autos.alliances }
}

function disabled(seconds: number): Step { return { mode: 'disabled', seconds, presses: [] } }
function teleop(seconds: number): Step { return { mode: 'teleop', seconds, presses: [] } }

// ---- Timelines ---------------------------------------------------------------------------------------------------

/** One run per alliance of a scenario, each with its timeline. */
export function runsOf(scenario: Scenario): Run[] {
  return scenario.alliances.map((alliance) => ({
    scenario,
    alliance,
    label: scenario.alliances.length > 1 ? `${scenario.name} (${alliance.replace(/\d$/, '').toLowerCase()})` : scenario.name,
    ...timeline(scenario, alliance),
  }))
}

function timeline(scenario: Scenario, alliance: Station): { timeline: string[]; seconds: number } {
  const lines: [number, string][] = [[0, `alliance ${alliance}`], [FIRST_DISABLED_SECONDS - 0.5, 'choosers']]
  if (scenario.auto) {
    lines.push([FIRST_DISABLED_SECONDS - 0.4, `select ${scenario.auto.chooser}|${scenario.auto.option}`])
    lines.push([FIRST_DISABLED_SECONDS - 0.1, 'choosers']) // so the run says whether the robot took the selection
  }
  let t = 0
  for (const step of scenario.steps) {
    // A press at 0 is played before the mode, so the robot sees both in the same loop (as a held button would be).
    for (const p of step.presses.filter((x) => x.at === 0)) lines.push([t, `${p.down} ${p.marker}`])
    lines.push([t, `mode ${step.mode}`])
    for (const p of step.presses) {
      const releaseAt = p.holdFor === null ? step.seconds : Math.min(p.at + p.holdFor, step.seconds)
      if (p.at > 0) lines.push([t + p.at, `${p.down} ${p.marker}`])
      lines.push([t + releaseAt - 0.01, p.up])
    }
    t += step.seconds
  }
  lines.push([t + 0.2, 'end'])
  // A stable sort: lines at the same time keep the order they were written in.
  const sorted = lines.map((l, i) => ({ l, i })).sort((a, b) => a.l[0] - b.l[0] || a.i - b.i)
  return { timeline: sorted.map(({ l }) => `${l[0].toFixed(3)} ${l[1]}`), seconds: t }
}
