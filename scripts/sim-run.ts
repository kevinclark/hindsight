/**
 * sim-run: run a team's robot code in WPILib's desktop simulator through scripted scenarios, and say what went wrong.
 * How to write a scenario file: docs/sim-run.md.
 *
 *   node scripts/sim-run.ts <robot-code folder> [--commit <sha>] [--scenarios <file>] [--only <name>,...]
 *                           [--repeat <n>] [--parallel <n>] [--java <JDK folder>] [--json <out.json>] [--verbose]
 *
 * Never changes the robot-code folder: it builds a copy. Exits 1 when it found a problem, 2 when the code didn't build.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NO_TEAM_FILE, readTeamFile } from '../src/simrun/scenario.ts'
import { simRun } from '../src/simrun/session.ts'
import { commandStory, report } from '../src/simrun/report.ts'

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.splice(i, 2)[1] : null
}
const verbose = args.includes('--verbose') ? Boolean(args.splice(args.indexOf('--verbose'), 1)) : false
const commit = option('commit')
const scenariosFile = option('scenarios')
const only = option('only')
const repeat = Number(option('repeat') ?? 1)
const parallel = Number(option('parallel') ?? 1)
const javaHome = option('java')
const jsonOut = option('json')
const robot = args[0]
if (!robot || !existsSync(join(robot, 'build.gradle'))) {
  console.error('usage: node scripts/sim-run.ts <robot-code folder (the one with build.gradle)> [options]')
  process.exit(2)
}

const teamFileName = scenariosFile ?? join(robot, 'sim-run.json')
const team = existsSync(teamFileName) ? readTeamFile(readFileSync(teamFileName, 'utf8'), teamFileName) : NO_TEAM_FILE
try {
  const result = await simRun({
    source: { robot, commit }, team, only: only ? only.split(',') : [], repeat, parallel, cache: join(tmpdir(), 'hindsight-sim-run'), javaHome,
    say: (line) => console.error(line),
  })
  console.log(report(result, `sim-run: ${robot}${commit ? ` at ${commit}` : ' (working tree)'}`))
  if (verbose) console.log(`\n${commandStory(result)}`)
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ findings: result.findings, hindsight: result.hindsight.map((h) => ({ rule: h.finding.rule, title: h.finding.title, runs: h.runs })), runs: result.results.map((r) => ({ label: r.run.label, ended: r.record.ended, killed: r.killed, wallSeconds: r.wallSeconds })), buildSeconds: result.built.buildSeconds, notes: result.notes }, null, 2))
  process.exit(result.findings.some((f) => f.severity === 'error') ? 1 : 0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
