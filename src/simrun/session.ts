/**
 * One sim-run: build the robot code once, run the start-up scenario (which also reads the auto chooser), then every
 * auto on each alliance, the drive check and the team's own scenarios, each on a freshly started robot program; then
 * run every check over all of them.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openWpilog } from '../readers/wpilog.ts'
import type { Finding as RuleFinding } from '../rules/types.ts'
import { readRun, type Chooser } from './events.ts'
import { build, copyRobot, runTimeline, workFolder, type Built, type Source } from './launch.ts'
import { hindsightOn, profileFacts, type ProfileFacts } from './hindsight.ts'
import { autoScenarios, driveScenario, runsOf, STARTUP, type Run, type Scenario, type TeamFile, type Zero } from './scenario.ts'
import { alliances } from './checks/alliance.ts'
import { autos } from './checks/auto.ts'
import { crash } from './checks/crash.ts'
import { expectations } from './checks/expect.ts'
import { loops } from './checks/loop.ts'
import { printedErrors } from './checks/printed.ts'
import { findPoseKey } from './checks/pose.ts'
import type { Check, Finding, RunResult } from './checks/types.ts'
import { zeroes } from './checks/zero.ts'

/** Assumed: under this, a run's clocks agree (timer jitter); over it, the computer slept. */
const SLEEP_SECONDS = 2
/** A .wpilog's header alone (no records): a run that crashed before its log got anything. */
const WPILOG_HEADER_BYTES = 12

export const CHECKS: Check[] = [crash, zeroes, expectations, autos, alliances, loops, printedErrors]

export interface Options {
  source: Source
  team: TeamFile
  /** Scenario names (or "startup", "autos", "drive") to run; empty runs them all. */
  only: string[]
  /** Runs of each scenario on each alliance (more than one where timing matters). */
  repeat: number
  /**
   * Robot programs at once after the start-up run. Measured: two at a time gave every backtest arm the same outcome
   * in each of its runs (row 1: 40 runs).
   */
  parallel: number
  cache: string
  javaHome: string | null
  say: (line: string) => void
}

export interface SessionResult {
  built: Built
  results: RunResult[]
  findings: Finding[]
  /** Hindsight's rule findings, sim artifacts left out, once per rule and what it is about, with the runs they came from. */
  hindsight: { finding: RuleFinding; runs: string[] }[]
  facts: ProfileFacts | null
  /** The zeroes checked: the team file's and the robot profile's. */
  zeroes: Zero[]
  notes: string[]
}

/** What a sim-run collects as its runs finish, and what the checks then read. */
interface Collected {
  built: Built
  work: string
  results: RunResult[]
  /** Hindsight's findings by their key (rule and what it is about), with the runs they came from. */
  hindsight: Map<string, { finding: RuleFinding; runs: string[] }>
  /** What the robot profile that fits the first log knows (zeroes, pose, auto chooser); null until a log fits one. */
  facts: ProfileFacts | null
  notes: string[]
  repeat: number
  say: (line: string) => void
}

export async function simRun(options: Options): Promise<SessionResult> {
  const { team, say } = options
  const work = workFolder(options.cache, options.source)
  say(`Copying ${options.source.commit ? `commit ${options.source.commit}` : 'the working tree'} to ${work}`)
  const folder = copyRobot(options.source, work)
  say('Building (offline first)...')
  const built = build(folder, work, options.javaHome)
  say(`Built in ${built.buildSeconds.toFixed(0)} s (GradleRIO ${built.gradleRio}).`)
  const got: Collected = { built, work, results: [], hindsight: new Map(), facts: null, notes: [], repeat: options.repeat, say }
  const wanted = (s: Scenario) => {
    const names = [s.name, s.kind === 'auto' ? 'autos' : s.kind].map((n) => n.toLowerCase())
    return options.only.length === 0 || options.only.some((o) => names.some((n) => n.includes(o.toLowerCase())))
  }

  // Always once: it reads the auto chooser, and its two enables are where most zeroes are first seen finishing.
  const [startupRun] = runsOf(STARTUP)
  const startup = await playRun(got, startupRun, 1, 0)
  const startupRepeats = wanted(STARTUP) ? options.repeat - 1 : 0
  for (let n = 2; n <= startupRepeats + 1; n++) await playRun(got, startupRun, n, n - 1)
  if (startup.record.started === null) {
    got.notes.push('The robot program crashed while starting, so no other scenario was run.')
    return finish(got, team)
  }
  const scenarios = [
    ...autoScenarios(chooserOf(startup, team, got), team, got.facts?.autoSeconds ?? undefined),
    ...[driveScenario(team)].filter((s) => s !== null),
    ...team.scenarios,
  ]
  // Each run, repeated: run 1 #1, run 1 #2, ..., run 2 #1, ...; each kept in that order after the start-up runs.
  const planned = scenarios.filter(wanted).flatMap((s) => runsOf(s)).flatMap((run) => Array.from({ length: options.repeat }, (_, n) => ({ run, n: n + 1 })))
  const first = got.results.length
  await inPool(planned.map(({ run, n }, i) => () => playRun(got, run, n, first + i)), options.parallel)
  return finish(got, team)
}

/** Plays one run, reads what it printed and logged, and keeps it at `index` (the order the runs were planned in). */
async function playRun(got: Collected, run: Run, n: number, index: number): Promise<RunResult> {
  const label = got.repeat > 1 ? `${run.label} #${n}` : run.label
  got.say(`Running ${label} (${run.seconds.toFixed(0)} s of sim, real time)...`)
  const logFile = join(got.work, `run-${index + 1}.wpilog`)
  const { output, killed, wallSeconds, sleptSeconds } = await runTimeline(got.built, run.timeline, run.seconds, logFile)
  const bytes = existsSync(logFile) ? new Uint8Array(readFileSync(logFile)) : null
  const log = bytes && bytes.length > WPILOG_HEADER_BYTES ? openWpilog(bytes) : null
  const read = bytes && log ? hindsightOn(`${label}.wpilog`, bytes) : null
  if (read && !got.facts) got.facts = profileFacts(read.match)
  for (const f of read?.findings ?? []) {
    const seen = got.hindsight.get(f.key) ?? { finding: f, runs: [] }
    seen.runs.push(label)
    got.hindsight.set(f.key, seen)
  }
  const result: RunResult = { run: { ...run, label }, record: readRun(output), log, repeat: n, wallSeconds, killed, sleptSeconds }
  got.results[index] = result
  return result
}

/** Every check over all the runs. */
function finish(got: Collected, team: TeamFile): SessionResult {
  const { built, facts, notes } = got
  // A run the computer slept through says nothing: the robot's clock ran on while the scenario stood still.
  const slept = got.results.filter((r) => r.sleptSeconds > SLEEP_SECONDS)
  if (slept.length) notes.push(`The computer slept during ${slept.map((r) => r.run.label).join(', ')}; those runs were not checked. Run again with it awake.`)
  const results = got.results.filter((r) => !slept.includes(r))
  const zeroList = mergeZeroes(team.zeroes, facts?.zeroes ?? [])
  const poseKey = findPoseKey(results.find((r) => r.log)?.log ?? null, facts?.poseKey ?? null)
  if (!poseKey && results.some((r) => r.record.ended)) notes.push('No robot pose in the log, so "did it move" and red-vs-blue were not checked.')
  if (results.every((r) => r.record.noLog)) notes.push(`No log was recorded: ${results[0].record.noLog}`)
  const context = { results, zeroes: zeroList, teamPackage: teamPackage(built.mainClass), poseKey }
  const findings = CHECKS.flatMap((check) => check(context))
  return { built, results: got.results, findings, hindsight: [...got.hindsight.values()], facts, zeroes: zeroList, notes }
}

/** Runs the jobs, at most `size` at a time. */
async function inPool(jobs: (() => Promise<unknown>)[], size: number): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < jobs.length) await jobs[next++]()
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker))
}

/** The auto chooser: the team file's, else the profile's, else the only one on SmartDashboard; null when none is. */
function chooserOf(startup: RunResult, team: TeamFile, got: Collected): Chooser | null {
  const { notes } = got
  const choosers = startup.record.choosers
  const wantedKey = team.autos.chooser ?? got.facts?.chooser
  const named = wantedKey ? choosers.find((c) => c.key === wantedKey) : undefined
  if (named) return named
  if (!wantedKey && choosers.length === 1) return choosers[0]
  if (wantedKey) {
    const keys = choosers.map((c) => c.key).join(', ') || 'none'
    notes.push(`No chooser "${wantedKey}" on SmartDashboard (found: ${keys}), so auto ran once, unselected.`)
  } else if (choosers.length > 1) {
    const keys = choosers.map((c) => c.key).join(', ')
    notes.push(`More than one chooser (${keys}): name the auto chooser in the scenario file ("autos": { "chooser": ... }).`)
  } else {
    notes.push('No auto chooser on SmartDashboard: auto ran once, with whatever the robot code starts.')
  }
  return null
}

/** The team file's zeroes, plus the profile's that the file doesn't name. */
function mergeZeroes(fromFile: Zero[], fromProfile: Zero[]): Zero[] {
  return [...fromFile, ...fromProfile.filter((p) => !fromFile.some((f) => f.name === p.name || f.done.source === p.done.source))]
}

/** "frc.robot.Main" → "frc.robot.": stack frames in this package are the team's code. */
function teamPackage(mainClass: string): string {
  return mainClass.split('.').slice(0, -1).join('.') + '.'
}
