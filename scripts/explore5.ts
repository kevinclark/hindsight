import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch, num, values, phaseAt } from '../src/match/match.ts'
import { offseason2026 as P } from '../src/profiles/2026-offseason.ts'
import { makeGrid, resample, valueAt, percentile, heldAt } from '../src/match/series.ts'
for (const f of process.argv.slice(2)) {
  const m = buildMatch(f, openWpilog(new Uint8Array(readFileSync(f))), P)
  console.log('=====', f.split('_').at(-1))
  // tilt
  for (const k of [P.signals.gyroPitch, P.signals.gyroRoll]) { const s = num(m,k)!; let inEv=false, st=0, pk=0
    for (let i=0;i<s.t.length;i++){ const d=s.v[i]*180/Math.PI; if(Math.abs(d)>15&&!inEv){inEv=true;st=s.t[i];pk=d} else if(inEv&&Math.abs(d)>Math.abs(pk)) pk=d; if(inEv&&Math.abs(d)<=15){console.log(' tilt',k.split('/').at(-1),st.toFixed(2),(s.t[i]-st).toFixed(2)+'s',pk.toFixed(1),phaseAt(m,st));inEv=false}} }
  // loop
  const L = num(m,P.signals.loopCycleMs)!; for (const ph of ['auto','teleop'] as const){ const xs:number[]=[]; for(const iv of m[ph]) for(let i=0;i<L.t.length;i++) if(L.t[i]>=iv.start&&L.t[i]<iv.end) xs.push(L.v[i]); console.log(' loop',ph,(100*xs.filter(x=>x>20).length/xs.length).toFixed(1)+'%','p99',percentile(xs,99).toFixed(0),'max',Math.max(...xs).toFixed(0))}
  // vision
  const odo = values<any>(m,P.signals.odometryPose)!
  for (const c of P.cameras){ const vp=values<any>(m,c.acceptedPose)!; let n=0,far=0,inm=0; const ds:number[]=[]; for(let i=0;i<vp.t.length;i++){ const t=vp.t[i]; if(m.matchStart===null||t<m.matchStart||t>m.matchEnd!) continue; inm++; const o=heldAt(odo,t); if(!o) continue; const d=Math.hypot(vp.v[i].x-o.x,vp.v[i].y-o.y); ds.push(d); if(d>0.5)far++; n++}
    const st=num(m,c.stale)!; let rises=0, trueT=0; for(let i=1;i<st.t.length;i++){ if(st.v[i]>0.5&&st.v[i-1]<0.5&&st.t[i]>m.matchStart!&&st.t[i]<m.matchEnd!) rises++; }
    for(let i=0;i<st.t.length-1;i++){ if(st.v[i]>0.5){ const a=Math.max(st.t[i],m.matchStart!), b=Math.min(st.t[i+1],m.matchEnd!); if(b>a) trueT+=b-a } }
    console.log(' cam',c.name,'accepted',n,'far',far,(100*far/n).toFixed(1)+'%','p90',percentile(ds,90).toFixed(2),'max',Math.max(...ds).toFixed(2),'stale rises',rises,'stale time',trueT.toFixed(1)+'s of',(m.matchEnd!-m.matchStart!).toFixed(0), 'conn', JSON.stringify(Array.from(num(m,c.connected)!.v)), Array.from(num(m,c.connected)!.t).map(x=>x.toFixed(1)).join(','))}
  // accel
  const ax=num(m,P.signals.accelX), ay=num(m,P.signals.accelY); if(ax&&ay){ const g=makeGrid(m.matchStart!,m.matchEnd!,0.02); const X=resample(ax,g),Y=resample(ay,g); const h=Array.from(X,(x,i)=>Math.hypot(x,Y[i])); console.log(' accel p99',percentile(h,99).toFixed(1),'max',Math.max(...h).toFixed(1), 'at', g[h.indexOf(Math.max(...h))].toFixed(2), '>20:', h.filter(x=>x>20).length, '>30:',h.filter(x=>x>30).length) } else console.log(' accel MISSING')
  // console zero
  const con = values<string>(m,P.signals.console)!; for(let i=0;i<con.t.length;i++) if(/zero/i.test(con.v[i])) console.log(' console',con.t[i].toFixed(2),JSON.stringify(con.v[i].slice(0,100)))
  // hood position around auto start
  const hp = num(m,'/Drum/Hood/PositionRotations')!; const a0=m.matchStart!; console.log(' hood', [-1,0,0.1,0.3,0.5,0.9,1.0,1.5,3].map(d=>`${(a0+d).toFixed(2)}:${(valueAt(hp,a0+d)*360).toFixed(1)}`).join(' '))
  // alerts
  for (const g of P.signals.alertGroups) for (const kind of ['errors','warnings','infos']) { const a=values<string[]>(m,`${g}/${kind}`); if(!a) continue; for(let i=0;i<a.t.length;i++) console.log(' alert',g.split('/').at(-1),kind,a.t[i].toFixed(2),JSON.stringify(a.v[i])) }
}
