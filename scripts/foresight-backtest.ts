/**
 * Foresight backtest: would each pit check have fired on robots that went on to play a match, and what happened next?
 *
 *   node --experimental-strip-types scripts/foresight-backtest.ts [--json out.json] [--whole-log] <log.wpilog | folder> ...
 *
 * For each .wpilog with the field attached before its first enable, it runs the live check's own engine
 * (src/foresight/engine.ts) every 10 s along the stretch from max(code start + 30 s, field attach) to the first
 * enable after the attach, the robot sitting disabled on the field. The field stretch stands in for the pit: the
 * same robot minutes later, with less handling. A check "fired" on a log when it was amber or red at any of those
 * moments. For each log it also lists what Hindsight found later in that match, so each fire can be judged true or
 * false by a person (docs/measurements.md, "Foresight backtest"); this script does not judge.
 *
 * Like the live page, the checks see only the signals Foresight would subscribe to for the log's profile
 * (src/foresight/keys.ts), plus where a plain WPILib (DataLogManager) log keeps the Driver Station and field state.
 * `--whole-log` gives them every signal in the log instead, to show the subscribed set is enough.
 *
 * Logs without the field attached before an enable are listed as excluded, with why.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch, num } from '../src/match/match.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { valueAt } from '../src/match/series.ts'
import { RecordStore } from '../src/foresight/records.ts'
import { evaluateForesight, SETTLE_SECONDS } from '../src/foresight/engine.ts'
import { FORESIGHT_RULES, runRules } from '../src/rules/index.ts'
import { foresightKeys } from '../src/foresight/keys.ts'
import { DATALOGMANAGER_SIGNALS } from '../src/profiles/datalogmanager.ts'

const STEP_SECONDS = 10

const args = process.argv.slice(2)
const jsonAt = args.indexOf('--json')
const jsonOut = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : null
const wholeAt = args.indexOf('--whole-log')
const wholeLog = wholeAt >= 0 && args.splice(wholeAt, 1).length > 0
const files = args.flatMap(function walk(p: string): string[] {
  return statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((f) => walk(join(p, f))) : p.endsWith('.wpilog') ? [p] : []
})

interface LogResult {
  file: string
  profile: string
  excluded?: string
  stretch?: { from: number; to: number; seconds: number; checks: number }
  /** Rules that could judge this log (not "not checked" at the last moment). */
  ran: string[]
  /** Rule → the finding titles it raised (amber/red) on the stretch. */
  fired: Record<string, string[]>
  grey: Record<string, string[]>
  /** Warnings and errors Hindsight found in the match itself. */
  later: string[]
}

const results: LogResult[] = []
for (const file of files) {
  const name = file.split('/').slice(-2).join('/')
  const log = openWpilog(new Uint8Array(readFileSync(file)))
  const { profile, choice } = chooseProfile(log, PROFILES)
  const match = buildMatch(name, log, profile, choice)
  const result: LogResult = { file: name, profile: `${profile.name} @ ${profile.code.branch}${choice.misfit ? ' (does not fit)' : ''}`, ran: [], fired: {}, grey: {}, later: [] }
  results.push(result)
  const fms = num(match, match.profile.signals.fmsAttached)
  const attach = fms ? Array.from(fms.t).find((_, i) => fms.v[i] > 0.5) : undefined
  const enable = attach === undefined ? undefined : match.enabled.find((iv) => iv.start > attach)?.start
  const from = attach === undefined ? NaN : Math.max(match.logStart + SETTLE_SECONDS, attach)
  if (attach === undefined) { result.excluded = 'the field (FMS) was never attached'; continue }
  if (enable === undefined) { result.excluded = 'never enabled after the field attached'; continue }
  if (valueAt(fms!, enable - 0.05) < 0.5) { result.excluded = 'the field detached before the first enable'; continue }
  if (enable - 0.1 <= from) { result.excluded = `enabled ${(enable - match.logStart).toFixed(0)} s after code start, before the 30 s settle ended`; continue }
  const keys = [...foresightKeys(profile), ...Object.values(DATALOGMANAGER_SIGNALS).flat()]
  const store = RecordStore.fromWpilog(log, wholeLog ? null : keys)
  const times: number[] = []
  for (let t = from + STEP_SECONDS; t < enable - 0.1; t += STEP_SECONDS) times.push(t)
  times.push(enable - 0.1)
  result.stretch = { from, to: enable, seconds: Math.round(enable - from), checks: times.length }
  let last: ReturnType<typeof evaluateForesight> | null = null
  for (const now of times) {
    last = evaluateForesight({ store, codeStart: match.logStart, now, lastPassingSha: null, profile })
    if (last.state !== 'checked') continue
    for (const item of last.verdict.items) {
      const into = item.level === 'grey' ? result.grey : result.fired
      const titles = (into[item.finding.rule] ??= [])
      if (!titles.includes(item.finding.title) && titles.length < 4) titles.push(item.finding.title)
    }
  }
  if (last?.state === 'checked') {
    const blind = new Set(last.report.skipped.filter((s) => !s.reason.startsWith('partly')).map((s) => s.rule))
    result.ran = FORESIGHT_RULES.map((r) => r.id).filter((id) => !blind.has(id) && !last!.report.crashed.some((c) => c.rule === id))
  }
  const report = runRules(match)
  result.later = report.findings
    .filter((f) => f.severity !== 'info' && f.time !== null && match.matchStart !== null && f.time >= match.matchStart)
    .map((f) => `${f.severity} ${f.rule}: ${f.title}`)
}

// Markdown report.
const used = results.filter((r) => !r.excluded)
console.log(`# Foresight backtest (${new Date().toLocaleDateString('sv')}, local date)\n`)
console.log(`${wholeLog ? 'Every signal in each log. ' : 'Only the signals Foresight subscribes to. '}${files.length} logs read; ${used.length} had the field attached before an enable; ${results.length - used.length} excluded.\n`)
console.log('| Check | Logs it could judge | Logs it fired on (amber/red) |\n|---|---|---|')
for (const rule of FORESIGHT_RULES) {
  const ran = used.filter((r) => r.ran.includes(rule.id))
  const fired = used.filter((r) => r.fired[rule.id])
  console.log(`| \`${rule.id}\` | ${ran.length} | ${fired.length}${fired.length ? `: ${fired.map((r) => r.file.split('/').pop()).join(', ')}` : ''} |`)
}
console.log('\n## Per log\n')
for (const r of results) {
  console.log(`### ${r.file}\n\nProfile: ${r.profile}.`)
  if (r.excluded) { console.log(`Excluded: ${r.excluded}.\n`); continue }
  console.log(`Stretch: ${r.stretch!.from.toFixed(1)}–${r.stretch!.to.toFixed(1)} s robot time (${r.stretch!.seconds} s, ${r.stretch!.checks} checks). Could judge: ${r.ran.length} of ${FORESIGHT_RULES.length}.\n`)
  for (const [rule, titles] of Object.entries(r.fired)) console.log(`- **fired** \`${rule}\`: ${titles.join(' / ')}`)
  if (!Object.keys(r.fired).length) console.log('- nothing fired')
  for (const [rule, titles] of Object.entries(r.grey)) console.log(`- context \`${rule}\`: ${titles.length} reading${titles.length === 1 ? '' : 's'}, e.g. ${titles[0]}`)
  console.log(`- later in the match (Hindsight): ${r.later.length ? '' : 'no warnings or errors'}`)
  for (const l of r.later.slice(0, 12)) console.log(`  - ${l}`)
  if (r.later.length > 12) console.log(`  - … ${r.later.length - 12} more`)
  console.log('')
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1))
