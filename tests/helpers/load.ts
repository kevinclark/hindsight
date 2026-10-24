import { readFileSync, existsSync } from 'node:fs'
import { offseason2026 } from '../../src/profiles/2026-offseason.ts'
import { analyzeFiles, type InputFile } from '../../src/analyze.ts'
import { writeDslog, writeWpilog, type Fixture } from './fixture-format.ts'
import { TEAM, teamPath } from './team-logs.ts'

export function loadFixture(name: string): InputFile[] {
  const f = JSON.parse(readFileSync(`fixtures/${name}.json`, 'utf8')) as Fixture
  const files: InputFile[] = [{ name: `${name}.wpilog`, bytes: writeWpilog(f.entries) }]
  if (f.dslog) files.push({ name: f.dslog.name, bytes: writeDslog(f.dslog) })
  return files
}

export function analyzeFixture(name: string) {
  return analyzeFiles(loadFixture(name), offseason2026)
}

/** Three of the team's 2026 match logs and log A's Driver Station log (tests/helpers/team-logs.ts). Never copied into the repo. */
export const LOGS = {
  a: teamPath(TEAM.logA),
  b: teamPath(TEAM.logB),
  c: teamPath(TEAM.logC),
  aDslog: teamPath(TEAM.logADslog),
}

export const haveLogs = Object.values(LOGS).every(existsSync)

export function readInput(path: string): InputFile {
  return { name: path.split('/').pop()!, bytes: new Uint8Array(readFileSync(path)) }
}

/** Rule ids that produced at least one finding (meta/not-checked excluded). */
export function fired(report: { findings: { rule: string }[] }): Set<string> {
  return new Set(report.findings.map((f) => f.rule).filter((r) => r !== 'meta/not-checked'))
}
