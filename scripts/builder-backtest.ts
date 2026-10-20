// The profile builder against the hand-written profiles, on real logs (paths as arguments; logs are never copied):
//   node --experimental-strip-types scripts/builder-backtest.ts <log.wpilog>...
// Per log: motors found / missed / false positive against the profile chooseProfile picks (a motor matches by any of
// its current keys), and each hand group next to the builder's groups.
import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { backtestLog } from '../src/builder/backtest.ts'

for (const path of process.argv.slice(2)) {
  const r = backtestLog(openWpilog(new Uint8Array(readFileSync(path))), PROFILES)
  console.log(`\n${path.split('/').pop()}  (hand profile: ${r.hand ?? 'none fits'})`)
  console.log(`  motors: found ${r.found}${r.hand ? ` of ${r.handMotors}` : ''}, missed ${r.missed.length}, false positive ${r.falsePositives.length}${r.hand ? '' : ' (no hand profile: every motor counts here)'}`)
  for (const m of r.missed) console.log(`    missed ${m}`)
  for (const m of r.falsePositives) console.log(`    ${r.hand ? 'false positive' : 'found'} ${m}`)
  for (const k of r.confirmKind) console.log(`    supply or stator? ${k}`)
  for (const n of r.notUsed) console.log(`    not used: ${n.key} (${n.why})`)
  for (const l of r.limits) console.log(`    v1 limit: ${l}`)
  for (const w of r.warnings) console.log(`    warning: ${w}`)
  for (const g of r.handGroups) console.log(`  hand ${g.name} (${g.size}) → ${g.built.join(' + ')}${g.exact ? '  ✓' : ''}`)
  console.log(`  built groups: ${r.builtGroups.map((g) => `${g.name} (${g.size}${g.evidence === 'one motor' ? '' : `, ${g.evidence}`})`).join(', ') || 'none'}`)
  if (r.hand) console.log(`  hand groups recovered exactly: ${r.handGroups.filter((g) => g.exact).length} of ${r.handGroups.length}`)
}
