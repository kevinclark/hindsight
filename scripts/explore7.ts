import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch, num } from '../src/match/match.ts'
import { offseason2026 as P } from '../src/profiles/2026-offseason.ts'
import { makeGrid, resample } from '../src/match/series.ts'
for (const f of process.argv.slice(2)) {
  const m = buildMatch(f, openWpilog(new Uint8Array(readFileSync(f))), P)
  const fl = P.motorGroups.find(g=>g.name==='Flywheel')!
  const grid = makeGrid(m.matchStart!, m.matchEnd!, 0.02)
  const sp = fl.motors.map(x=>resample(num(m,x.velocity!)!,grid).map(Math.abs))
  const cmd = resample(num(m,'/Drum/Flywheel/Leader/Voltage')!, grid)
  const res:string[]=[]
  for (const steadyMode of ['speed','volt']) for (const thr of [0.10,0.15,0.20]) {
    let n=0, bad=[0,0,0,0]; 
    for(let i=25;i<grid.length;i++){ const L=sp[0][i]; if(!(L>20)) continue;
      const steady = steadyMode==='speed' ? Math.abs(L-sp[0][i-25])<=0.03*L : Math.abs(cmd[i]-cmd[i-25])<=0.5 && Math.abs(cmd[i])>1
      if(!steady) continue; n++; sp.forEach((s,k)=>{ if(Math.abs(1-s[i]/L)>thr) bad[k]++ }) }
    res.push(`${steadyMode}>${thr}: n=${(n*0.02).toFixed(0)}s bad=${bad.map(b=>(b*0.02).toFixed(1)).join('/')}`)
  }
  console.log(f.split('_').at(-1), res.join(' | '))
}
