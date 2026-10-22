/**
 * sim-run: run a team's robot code in WPILib's desktop simulator through scripted scenarios, and say what went wrong.
 * How to write a scenario file: docs/sim-run.md.
 *
 *   node scripts/sim-run.ts <robot-code folder> [--commit <sha>] [--scenarios <file>] [--only <name>,...]
 *                           [--repeat <n>] [--parallel <n>] [--java <JDK folder>] [--json <out.json>] [--verbose]
 *
 * Never changes the robot-code folder: it builds a copy. Exits 1 when it found a problem, 2 when it couldn't run
 * (a scenario file it can't read, code that doesn't build).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_TEAM_FILE, readTeamFile } from '../src/simrun/scenario.ts'
import { simRun, type SessionResult } from '../src/simrun/session.ts'
import { commandStory, report } from '../src/simrun/report.ts'

const args = process.argv.slice(2)
/** The value after --name, taken out of args; null when not given. */
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const verbose = args.includes('--verbose')
if (verbose) args.splice(args.indexOf('--verbose'), 1)
const commit = option('commit')
const scenariosFile = option('scenarios')
const only = option('only')
const repeat = count(option('repeat'), 'repeat')
const parallel = count(option('parallel'), 'parallel')
const javaHome = option('java')
const jsonOut = option('json')
const robot = args[0]
if (!robot || !existsSync(join(robot, 'build.gradle'))) {
  console.error('usage: node scripts/sim-run.ts <robot-code folder (the one with build.gradle)> [options]')
  process.exit(2)
}

try {
  const teamFileName = scenariosFile ?? join(robot, 'sim-run.json')
  const team = existsSync(teamFileName) ? readTeamFile(readFileSync(teamFileName, 'utf8'), teamFileName) : NO_TEAM_FILE
  const result = await simRun({
    source: { robot, commit }, team, only: only ? only.split(',') : [], repeat, parallel, javaHome,
    cache: join(tmpdir(), 'hindsight-sim-run'),
    say: (line) => console.error(line),
  })
  console.log(report(result, `sim-run: ${robot}${commit ? ` at ${commit}` : ' (working tree)'}`))
  if (verbose) console.log(`\n${commandStory(result)}`)
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary(result), null, 2))
  process.exit(result.findings.some((f) => f.severity === 'error') ? 1 : 0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

/** A whole number of 1 or more for --repeat or --parallel (1 when not given). */
function count(value: string | null, name: string): number {
  const n = Number(value ?? 1)
  if (Number.isInteger(n) && n >= 1) return n
  console.error(`--${name} needs a whole number, 1 or more (got "${value}")`)
  process.exit(2)
}

/** What --json writes: the findings and each run's outcome, for scripts (the backtest reads it). */
function summary(result: SessionResult) {
  return {
    findings: result.findings,
    hindsight: result.hindsight.map((h) => ({ rule: h.finding.rule, title: h.finding.title, runs: h.runs })),
    runs: result.results.map((r) => ({ label: r.run.label, ended: r.record.ended, killed: r.killed, wallSeconds: r.wallSeconds, sleptSeconds: r.sleptSeconds })),
    buildSeconds: result.built.buildSeconds,
    notes: result.notes,
  }
}
