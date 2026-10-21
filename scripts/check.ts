// Print the lint report for one or more logs: node --experimental-strip-types scripts/check.ts <wpilog> [dslog]
import { readFileSync } from 'node:fs'
import { analyze } from '../src/analyze.ts'
const files = process.argv.slice(2).map((p) => ({ name: p.split('/').pop()!, bytes: new Uint8Array(readFileSync(p)) }))
for (const a of analyze(files)) {
  console.log(`\n=== ${a.match.fileName}  ${a.match.event} ${a.match.matchLabel}  parse ${a.timing.parseMs.toFixed(0)} ms, rules ${a.timing.rulesMs.toFixed(0)} ms${[...a.match.ds, ...a.match.dsEvents].map((d) => '  + ' + d.fileName).join('')}`)
  for (const f of a.report.findings) {
    const by = f.explainedBy ? `\n          explained by ${f.explainedBy.rule}${f.explainedBy.about ? ` (${f.explainedBy.about})` : ''}: ${f.explainedBy.why}` : ''
    console.log(`${f.severity.padEnd(7)} ${f.rule.padEnd(26)} ${f.title}${by}\n          ${JSON.stringify(f.evidence)}`)
  }
  for (const c of a.report.crashed) console.log('CRASHED', c)
}
