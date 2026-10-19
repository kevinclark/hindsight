import { readFileSync, existsSync } from 'node:fs'
import { offseason2026 } from '../../src/profiles/2026-offseason.ts'
import { homedir } from 'node:os'
import { analyzeFiles, type InputFile } from '../../src/analyze.ts'
import { writeDslog, writeWpilog, type Fixture } from './fixture-format.ts'

export function loadFixture(name: string): InputFile[] {
  const f = JSON.parse(readFileSync(`fixtures/${name}.json`, 'utf8')) as Fixture
  const files: InputFile[] = [{ name: `${name}.wpilog`, bytes: writeWpilog(f.entries) }]
  if (f.dslog) files.push({ name: f.dslog.name, bytes: writeDslog(f.dslog) })
  return files
}

export function analyzeFixture(name: string) {
  return analyzeFiles(loadFixture(name), offseason2026)
}

/** The real CalGames logs, read-only from ~/Downloads. Never copied into the repo. */
export const CALGAMES = {
  q13: `${homedir()}/Downloads/akit_26-10-17_20-07-34_cacg_q13.wpilog`,
  q21: `${homedir()}/Downloads/akit_26-10-17_21-24-40_cacg_q21.wpilog`,
  p0: `${homedir()}/Downloads/akit_26-10-18_16-31-52_cacg_p0.wpilog`,
  q13dslog: `${homedir()}/Downloads/2026_10_17 13_07_13 Sat.dslog`,
}

export const haveCalGames = Object.values(CALGAMES).every(existsSync)

export function readInput(path: string): InputFile {
  return { name: path.split('/').pop()!, bytes: new Uint8Array(readFileSync(path)) }
}

/** Rule ids that produced at least one finding (meta/not-checked excluded). */
export function fired(report: { findings: { rule: string }[] }): Set<string> {
  return new Set(report.findings.map((f) => f.rule).filter((r) => r !== 'meta/not-checked'))
}
