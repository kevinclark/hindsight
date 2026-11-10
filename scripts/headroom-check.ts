// Power -> Headroom on whole logs with their profiles (as the app picks them): one line per motor group.
//   npx vite-node scripts/headroom-check.ts <log.wpilog | folder> ...
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildMatch } from '../src/match/match.ts'
import { buildHeadroom, headroomVerdicts } from '../src/power/headroom.ts'
import { chooseProfile } from '../src/profiles/choose.ts'
import { PROFILES } from '../src/profiles/index.ts'
import { openWpilog } from '../src/readers/wpilog.ts'

const files = (p: string): string[] => (statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => files(join(p, f))) : p.endsWith('.wpilog') ? [p] : [])
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '   –' : `${Math.round(100 * x)}%`.padStart(4))
for (const f of process.argv.slice(2).flatMap(files)) {
  const log = openWpilog(new Uint8Array(readFileSync(f)))
  const { profile, choice } = chooseProfile(log, PROFILES)
  const match = buildMatch(f.split('/').pop()!, log, profile, choice)
  console.log(`\n== ${f.split('/').pop()}  profile ${profile.name}`)
  console.log(`  verdicts: ${headroomVerdicts(buildHeadroom(match)).map((v) => `${v.group}: ${v.kind}`).join('; ') || 'none'}`)
  for (const g of buildHeadroom(match)) {
    const top = g.topSpeed ? `top p50 ${g.topSpeed.p50.toFixed(2)} p90 ${g.topSpeed.p90.toFixed(2)} near ${pct(g.topSpeed.nearTop)} A@near ${g.ampsNearTop?.toFixed(0) ?? '–'}` : 'top –'
    const sp = g.setpoint ? `  setpoint needs ${g.setpoint.needsVolts.toFixed(1)} V ${g.setpoint.seconds.toFixed(0)} s under ${pct(g.setpoint.pastTop)} short there ${pct(g.setpoint.shortWhenPastTop)} else ${pct(g.setpoint.shortOtherwise)}` : ''
    console.log(`  ${g.group.padEnd(16)} run ${g.runningSeconds.toFixed(0).padStart(5)} s  stator ${pct(g.atStator)} supply ${pct(g.atSupply)}  ${top}${sp}`)
  }
}
