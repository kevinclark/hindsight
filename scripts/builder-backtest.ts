// The profile builder against the hand-written profiles, on real logs (paths as arguments; logs are never copied):
//   node --experimental-strip-types scripts/builder-backtest.ts <log.wpilog>...
// Per log: motors found / missed / false positive against the profile chooseProfile picks (a motor matches by any of
// its current keys), and each hand group next to the builder's groups.
//
// With the robot code (a read-only clone with its .git), each log is also drafted from the code at the commit it ran
// (its GitSHA, else --commit), and the draft is scored: which motors got a current kind, a CAN ID, a group and limits
// from the code, and against the hand profile when one fits:
//   node --experimental-strip-types scripts/builder-backtest.ts --code <repo folder> [--commit <sha>] <log.wpilog>...
import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { backtestLog } from '../src/builder/backtest.ts'
import { codeHints } from '../src/builder/code-hints.ts'
import { allMotors, draftProfile } from '../src/builder/draft.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { firstText } from '../src/profiles/formats.ts'
import { GitRepo } from '../src/code/git.ts'
import { nodeGitDir } from '../src/code/node-git-dir.ts'
import { javaFilesAt } from '../src/code/source.ts'
import { loadJavaFromDisk } from '../src/code/check/node-java.ts'

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const codeDir = option('--code')
const commit = option('--commit')
if (codeDir) await loadJavaFromDisk()

for (const path of args) {
  const log = openWpilog(new Uint8Array(readFileSync(path)))
  const r = backtestLog(log, PROFILES)
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
  if (codeDir) await withCode(log, path.split('/').pop()!)
}

/** Draft the log with the code at its commit, and score what the code filled in. */
async function withCode(log: ReturnType<typeof openWpilog>, fileName: string) {
  const gitDir = nodeGitDir(codeDir!)
  if (!gitDir) throw new Error(`${codeDir} has no .git folder`)
  const repo = new GitRepo(gitDir)
  const ran = firstText(log, '/RealMetadata/GitSHA') || commit
  if (!ran) { console.log('  code: the log names no commit; pass --commit'); return }
  let sha: string
  try { sha = await repo.resolve(ran) } catch (error) { console.log(`  code: ${ran.slice(0, 7)} isn't in this repo (${error instanceof Error ? error.message : error}): nothing to draft from`); return }
  const hints = codeHints(await javaFilesAt(repo, sha), { sha, branch: null })
  const { json, warnings } = draftProfile({ logs: [{ log, fileName }], hints })
  const motors = allMotors(json).map((x) => x.motor)
  const kinds = motors.filter((m) => m.kindFrom === 'code').length
  const unknownKind = motors.filter((m) => m.current).length
  const ids = motors.filter((m) => m.canIdFrom === 'code').length
  console.log(`  code @ ${sha.slice(0, 7)}: ${hints.motors.length} Talon FX built, ${motors.length} in the draft; kind from code ${kinds}, still "supply or stator?" ${unknownKind}; CAN ID from code ${ids}`)
  for (const g of json.motorGroups) {
    const l = g.limits
    const limits = g.limitsFromCode && l ? ` limits ${[l.supplyA !== undefined || l.supplyEnabled !== undefined ? `supply ${l.supplyA ?? '?'} A ${l.supplyEnabled === false ? 'off' : 'on'}` : '', l.statorA !== undefined || l.statorEnabled !== undefined ? `stator ${l.statorA ?? '?'} A ${l.statorEnabled === false ? 'off' : 'on'}` : ''].filter(Boolean).join(', ')} (${l.where})` : ' limits: none from code'
    console.log(`    group ${g.name} (${g.motors.length}, ${g.groupedBy}${g.groupFromCode ? ', code agrees' : ''}${g.sameLoop ? ', same loop' : ''}):${limits}`)
  }
  for (const w of warnings) console.log(`    note: ${w}`)
  const { profile, choice } = chooseProfile(log, PROFILES)
  if (choice.misfit) return
  // Against the hand profile: each hand motor's ID and keys, each hand group's limits.
  let id = 0, supply = 0, stator = 0, n = 0
  for (const g of profile.motorGroups) for (const h of g.motors) {
    n++
    const d = motors.find((m) => [m.supplyCurrent, m.statorCurrent, m.current].some((k) => k && (k === h.supplyCurrent || k === h.statorCurrent)))
    id += +(d?.canId === h.canId); supply += +(d?.supplyCurrent === h.supplyCurrent); stator += +(d?.statorCurrent === h.statorCurrent)
  }
  console.log(`  vs hand profile ${profile.name}: CAN IDs ${id} of ${n}, supply keys ${supply} of ${n}, stator keys ${stator} of ${n}`)
  for (const g of profile.motorGroups) {
    const d = json.motorGroups.find((x) => x.motors.some((m) => g.motors.some((h) => [m.supplyCurrent, m.statorCurrent].includes(h.supplyCurrent ?? h.statorCurrent))))
    const same = (a?: number | boolean, b?: number | boolean) => a === b
    const l = d?.limits, h = g.limits
    const agree = !!l && d!.limitsFromCode && same(l.supplyA, h.supplyA) && same(l.supplyEnabled, h.supplyEnabled) && same(l.statorA, h.statorA) && same(l.statorEnabled, h.statorEnabled)
    console.log(`    ${g.name}: hand supply ${h.supplyA ?? '-'}/${h.supplyEnabled ?? '-'} stator ${h.statorA ?? '-'}/${h.statorEnabled ?? '-'} (${h.where}); draft ${d ? `${d.name} (${d.motors.length})` : 'none'} ${l && d!.limitsFromCode ? `supply ${l.supplyA ?? '-'}/${l.supplyEnabled ?? '-'} stator ${l.statorA ?? '-'}/${l.statorEnabled ?? '-'} (${l.where})` : 'no code limits'}${agree ? '  ✓' : ''}${d && d.motors.length === g.motors.length ? '' : '  size differs'}`)
  }
}
