import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch } from '../src/match/match.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { buildPowerGrid } from '../src/power/battery-model.ts'
const med=(a:number[])=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1]}
for (const f of process.argv.slice(2)) {
  const m = buildMatch(f, openWpilog(new Uint8Array(readFileSync(f))), offseason2026)
  const g = buildPowerGrid(m)!
  const out:string[]=[]
  for (const lag of [1,2,3,5,10]) {
    const rs:number[]=[]
    for (let i=lag;i<g.t.length;i++){ if(!g.enabled[i]||!g.enabled[i-lag])continue; const dI=g.amps[i]-g.amps[i-lag]; if(Math.abs(dI)<100)continue; rs.push(-(g.volts[i]-g.volts[i-lag])/dI)}
    out.push(`lag${lag}: ${(med(rs)*1000).toFixed(1)}mΩ n=${rs.length}`)
  }
  // windowed regression 1 s
  for (const W of [25,50]) { const rs:number[]=[]
  for (let i=0;i+W<g.t.length;i+=W/5){ let ok=true; let sI=0,sV=0,sII=0,sIV=0,n=0,mn=1e9,mx=-1e9; for(let j=i;j<i+W;j++){ if(!g.enabled[j]){ok=false;break} const I=g.amps[j],V=g.volts[j]; sI+=I;sV+=V;sII+=I*I;sIV+=I*V;n++; mn=Math.min(mn,I);mx=Math.max(mx,I)} if(!ok||mx-mn<100)continue; const b=(n*sIV-sI*sV)/(n*sII-sI*sI); rs.push(-b)}
  out.push(`win${W}: ${(med(rs)*1000).toFixed(1)}mΩ n=${rs.length}`) }
  console.log(f.split('_').at(-1), out.join(' | '))
}
