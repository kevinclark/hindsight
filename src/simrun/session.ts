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
import { loops, printedErrors } from './checks/loop.ts'
import { findPoseKey } from './checks/pose.ts'
import type { Check, Finding, RunResult } from './checks/types.ts'
import { zeroes } from './checks/zero.ts'

export const CHECKS: Check[] = [crash, zeroes, expectations, autos, alliances, loops, printedErrors]

export interface Options {
  source: Source
  team: TeamFile
  /** Scenario names (or "startup", "autos", "drive") to run; empty runs them all. */
  only: string[]
  /** Runs of each scenario on each alliance (more than one where timing matters). */
  repeat: number
  /** Robot programs at once after the start-up run (measured: 2 at once give the same events as 1, n = 1 pair). */
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

export async function simRun(options: Options): Promise<SessionResult> {
  const { team, say } = options
  const work = workFolder(options.cache, options.source)
  say(`Copying ${options.source.commit ? `commit ${options.source.commit}` : 'the working tree'} to ${work}`)
  const folder = copyRobot(options.source, work)
  say('Building (offline first)...')
  const built = build(folder, work, options.javaHome)
  say(`Built in ${built.buildSeconds.toFixed(0)} s (GradleRIO ${built.gradleRio}).`)
  const notes: string[] = []
  const results: RunResult[] = []
  const hindsight = new Map<string, { finding: RuleFinding; runs: string[] }>()
  // The first log that fits a Hindsight robot profile says what the profile knows (zeroes, pose, auto chooser).
  const profile: { facts: ProfileFacts | null } = { facts: null }
  let runCount = 0
  const play = async (run: Run, n: number) => {
    const index = runCount++
    const label = options.repeat > 1 ? `${run.label} #${n}` : run.label
    say(`Running ${label} (${run.seconds.toFixed(0)} s of sim, real time)...`)
    const logFile = join(work, `run-${index + 1}.wpilog`)
    const { output, killed, wallSeconds } = await runTimeline(built, run.timeline, run.seconds, logFile)
    const record = readRun(output)
    const bytes = existsSync(logFile) ? new Uint8Array(readFileSync(logFile)) : null
    const log = bytes && bytes.length > 12 ? openWpilog(bytes) : null
    const read = bytes && log ? hindsightOn(`${label}.wpilog`, bytes) : null
    if (read && !profile.facts) profile.facts = profileFacts(read.match)
    for (const f of read?.findings ?? []) {
      const seen = hindsight.get(f.key) ?? { finding: f, runs: [] }
      seen.runs.push(label)
      hindsight.set(f.key, seen)
    }
    const result: RunResult = { run: { ...run, label }, record, log, repeat: n, wallSeconds, killed }
    results[index] = result // in the order the runs were planned, whichever finishes first
    return result
  }
  const wanted = (s: Scenario) => options.only.length === 0 || options.only.some((o) => [s.name, s.kind === 'auto' ? 'autos' : s.kind].some((n) => n.toLowerCase().includes(o.toLowerCase())))

  // Always once: it reads the auto chooser, and its two enables are where most zeroes are first seen finishing.
  const startup = await play(runsOf(STARTUP)[0], 1)
  for (let n = 2; n <= options.repeat && wanted(STARTUP); n++) await play(runsOf(STARTUP)[0], n)
  const { facts } = profile
  if (startup.record.started === null) {
    notes.push('The robot program crashed while starting, so no other scenario was run.')
    return finish(built, results, team, profile.facts, hindsight, notes)
  }
  const chooser = chooserOf(startup, team, facts, notes)
  const scenarios = [
    ...autoScenarios(chooser, team, facts?.autoSeconds ?? undefined),
    ...[driveScenario(team)].filter((s) => s !== null),
    ...team.scenarios,
  ]
  const runs = scenarios.filter(wanted).flatMap((s) => runsOf(s))
  await inPool(runs.flatMap((run) => Array.from({ length: options.repeat }, (_, i) => () => play(run, i + 1))), options.parallel)

  return finish(built, results, team, facts, hindsight, notes)
}

/** Every check over all the runs. */
function finish(built: Built, results: RunResult[], team: TeamFile, facts: ProfileFacts | null, hindsight: Map<string, { finding: RuleFinding; runs: string[] }>, notes: string[]): SessionResult {
  const zeroList = mergeZeroes(team.zeroes, facts?.zeroes ?? [])
  const poseKey = findPoseKey(results.find((r) => r.log)?.log ?? null, facts?.poseKey ?? null)
  if (!poseKey && results.some((r) => r.record.ended)) notes.push('No robot pose in the log, so "did it move" and red-vs-blue were not checked.')
  if (results.every((r) => r.record.noLog)) notes.push(`No log was recorded: ${results[0].record.noLog}`)
  const context = { results, zeroes: zeroList, teamPackage: teamPackage(built.mainClass), poseKey }
  const findings = CHECKS.flatMap((check) => check(context))
  return { built, results, findings, hindsight: [...hindsight.values()], facts, zeroes: zeroList, notes }
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
function chooserOf(startup: RunResult, team: TeamFile, facts: ProfileFacts | null, notes: string[]): Chooser | null {
  const choosers = startup.record.choosers
  const wantedKey = team.autos.chooser ?? facts?.chooser
  const named = wantedKey ? choosers.find((c) => c.key === wantedKey) : undefined
  if (named) return named
  if (!wantedKey && choosers.length === 1) return choosers[0]
  if (choosers.length > 1) {
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
