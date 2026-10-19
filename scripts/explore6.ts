import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch, num } from '../src/match/match.ts'
import { offseason2026 as P } from '../src/profiles/2026-offseason.ts'
import { makeGrid, resample, percentile } from '../src/match/series.ts'
import { intervalsWhere } from '../src/rules/helpers.ts'
for (const f of process.argv.slice(2)) {
  const m = buildMatch(f, openWpilog(new Uint8Array(readFileSync(f))), P)
  const fl = P.motorGroups.find(g=>g.name==='Flywheel')!
  const grid = makeGrid(m.teleop[0].start, m.matchEnd!, 0.02)
  const sp = fl.motors.map(x=>resample(num(m,x.velocity!)!,grid))
  const volt = resample(num(m,'/Drum/Flywheel/Leader/Voltage')!, grid)
  console.log(f.split('_').at(-1))
  for (const t0 of [352.5,376.0,393.2]) { const i=Math.round((t0-grid[0])/0.02); if(i>0&&i<grid.length) console.log('  ', t0, sp.map(s=>s[i].toFixed(1)).join(' / '), 'V', volt[i].toFixed(1)) }
  // ratio distribution where leader > 20
  const r = sp.map(()=>[] as number[]); for(let i=25;i<grid.length;i++){ const L=Math.abs(sp[0][i]); if(L<20) continue; sp.forEach((s,k)=>r[k].push(Math.abs(s[i])/L)) }
  console.log('  n', r[0].length, 'median ratios', r.map(x=>percentile(x,50).toFixed(2)).join(' '), 'p10', r.map(x=>percentile(x,10).toFixed(2)).join(' '))
  const under = intervalsWhere(num(m,P.signals.batteryVoltage)!, v=>v<7, m.teleop, m.logEnd); console.log('  under7', under.map(iv=>`${iv.start.toFixed(2)}+${(iv.end-iv.start).toFixed(2)}`).join(' '))
}
