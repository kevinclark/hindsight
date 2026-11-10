/**
 * Foresight's on-check backtest: every pit log (the field never attached) replayed through the live engine the way
 * live.ts reads a robot (src/foresight/replay.ts: records in time order, prune and a check every second).
 *
 *   node --experimental-strip-types scripts/foresight-oncheck-backtest.ts [--json out.json] [--no-settle] [--first <s>] <log.wpilog | folder> ...
 *
 * For each log it records, in seconds after code start:
 *   - each on-check rule (`onCheck`, src/rules/): when it first went amber or red, whether the robot was enabled then, and
 *     what it said at the log's end (its line on the page: OK, Look at, Not checked);
 *   - each other check that went amber or red in a checked result, with when it first and last did, and whether it was
 *     still up at the end (the start-up settle per check, engine.ts, is what keeps boot transients out);
 *   - the first moment the verdict could read anything, and the verdict at the end;
 *   - ms per check (median, 90th percentile, max).
 * `--no-settle` runs every check from the first second (no start-up settle at all), to measure which ones need one;
 * `--first <s>` stops each replay that many seconds after code start (the settle question needs only the first minute).
 * A pit log that was never enabled is replayed too (its on-check rules say not checked).
 * It judges nothing: a person reads each fire against the log (docs/measurements.md, "Foresight on-check backtest").
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch, num } from '../src/match/match.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { replayLive, type ReplayStep } from '../src/foresight/replay.ts'
import { allItems } from '../src/foresight/verdict.ts'
import { markOnRun } from '../src/foresight/onchecks.ts'
import { ONCHECK_RULES } from '../src/rules/index.ts'

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 && args.splice(i, 1).length > 0 }
const jsonAt = args.indexOf('--json')
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null
const noSettle = flag('--no-settle')
const firstAt = args.indexOf('--first')
const firstSeconds = firstAt >= 0 ? Number(args.splice(firstAt, 2)[1]) : Infinity
const files = args.flatMap(function walk(p: string): string[] {
  return statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((f) => walk(join(p, f))) : p.endsWith('.wpilog') ? [p] : []
})

interface Fire { first: number; enabled: boolean; last: number; atEnd: boolean; title: string }
interface LogResult {
  file: string
  profile: string
  excluded?: string
  enables?: [number, number][]
  onCheck?: Record<string, { fired: Fire | null; endLine: string }>
  flagged?: Record<string, Fire>
  firstVerdict?: { at: number; verdict: string } | null
  endVerdict?: string
  ms?: { checks: number; median: number; p90: number; max: number }
}

const round = (x: number) => Math.round(x * 10) / 10
const results: LogResult[] = []
for (const file of files) {
  const name = file.split('/').slice(-2).join('/')
  const log = openWpilog(new Uint8Array(readFileSync(file)))
  const { profile, choice } = chooseProfile(log, PROFILES)
  const match = buildMatch(name, log, profile, choice)
  const result: LogResult = { file: name, profile: `${profile.name} @ ${profile.code.branch}${choice.misfit ? ' (does not fit)' : ''}` }
  results.push(result)
  const fms = num(match, match.profile.signals.fmsAttached)
  if (fms && Array.from(fms.v).some((v) => v > 0.5)) { result.excluded = 'the field attached: a match, not a pit run'; continue }
  const start = match.logStart
  const rel = (t: number) => round(t - start)
  const enabledAt = (t: number) => match.enabled.some((iv) => t >= iv.start && t <= iv.end)
  result.enables = match.enabled.map((iv) => [rel(iv.start), rel(iv.end)])
  const onCheck: NonNullable<LogResult['onCheck']> = {}
  const flagged: Record<string, Fire> = {}
  const note = (into: Record<string, Fire>, key: string, title: string, t: number) => {
    const f = into[key]
    if (f) { f.last = rel(t); f.title = title } else into[key] = { first: rel(t), enabled: enabledAt(t), last: rel(t), atEnd: false, title }
  }
  const onFires: Record<string, Fire> = {}
  // Each check is read as it comes and dropped: a 35-minute boot is ~2,000 checks, each holding a whole match model.
  const ms: number[] = []
  let last: ReplayStep | null = null
  let firstChecked: { at: number; verdict: string } | null = null
  for (const step of replayLive(log, profile, choice, noSettle ? { settle: () => 0 } : {})) {
    if (step.now - match.logStart > firstSeconds) break
    last = step
    ms.push(step.ms)
    for (const i of allItems(step.result.onchecks.verdict)) if (i.level !== 'grey') note(onFires, i.finding.rule, i.finding.title, step.now)
    if (step.result.state !== 'checked') continue
    firstChecked ??= { at: rel(step.now), verdict: step.result.verdict.verdict }
    for (const i of allItems(step.result.verdict)) if (i.level !== 'grey' && !ONCHECK_RULES.some((r) => r.id === i.finding.rule)) note(flagged, `${i.finding.rule} · ${i.finding.about ?? ''}`, i.finding.title, step.now)
  }
  if (!last) { result.excluded = 'no records'; continue }
  const endItems = last.result.state === 'checked' ? allItems(last.result.verdict) : []
  for (const [key, f] of Object.entries(flagged)) f.atEnd = endItems.some((i) => `${i.finding.rule} · ${i.finding.about ?? ''}` === key && i.level !== 'grey')
  const endLines = markOnRun(last.result.onchecks)
  for (const r of ONCHECK_RULES) {
    const fired = onFires[r.id] ?? null
    if (fired) fired.atEnd = allItems(last.result.onchecks.verdict).some((i) => i.finding.rule === r.id && i.level !== 'grey')
    const line = endLines.find((l) => l.rules?.includes(r.id))
    onCheck[r.id] = { fired, endLine: line ? `${line.state}: ${line.detail}` : '' }
  }
  result.onCheck = onCheck
  result.flagged = flagged
  result.firstVerdict = firstChecked
  result.endVerdict = last.result.state === 'checked' ? `${last.result.verdict.verdict}: ${last.result.verdict.reason}` : `${last.result.state}: ${last.result.reason}`
  ms.sort((a, b) => a - b)
  const q = (p: number) => round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))])
  result.ms = { checks: ms.length, median: q(0.5), p90: q(0.9), max: round(ms[ms.length - 1]) }
  console.error(`${name}: ${ms.length} checks, ${Object.values(onFires).length} on-check fires, ${Object.keys(flagged).length} others flagged`)
}

// Text summary: one line per log, then the fires.
for (const r of results) {
  if (r.excluded) { console.log(`${r.file}  excluded: ${r.excluded}`); continue }
  const on = Object.entries(r.onCheck ?? {}).map(([rule, o]) => `${rule} ${o.fired ? `fired at ${o.fired.first} s${o.fired.enabled ? ' (enabled)' : ''}` : 'quiet'}; end: ${o.endLine}`).join(' | ')
  console.log(`${r.file}  enables ${JSON.stringify(r.enables)}  first verdict ${r.firstVerdict ? `${r.firstVerdict.verdict} at ${r.firstVerdict.at} s` : 'none'}  end ${r.endVerdict}  ms ${r.ms?.median}/${r.ms?.p90}/${r.ms?.max}`)
  console.log(`  on checks: ${on}`)
  for (const [key, f] of Object.entries(r.flagged ?? {})) console.log(`  flagged ${key}: ${f.first}–${f.last} s${f.atEnd ? ', still at the end' : ', cleared'}: ${f.title}`)
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1))
