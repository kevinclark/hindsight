import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
import { buildMatch } from '../src/match/match.ts'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { buildPowerGrid, fitBattery, resistanceFromSteps, ocvCurve, replayCap, voltageStats } from '../src/power/battery-model.ts'
for (const f of process.argv.slice(2)) {
  const t0 = performance.now()
  const log = openWpilog(new Uint8Array(readFileSync(f)))
  const m = buildMatch(f, log, offseason2026)
  const g = buildPowerGrid(m)!
  const fit = fitBattery(g)!
  const t1 = performance.now()
  console.log(f.split('_').at(-1), m.event, m.matchLabel, m.fms, 'auto', m.auto, 'tele', m.teleop.map(x=>[x.start.toFixed(2),x.end.toFixed(2)]))
  console.log(' fit', JSON.stringify(fit), 'ms', (t1-t0).toFixed(0))
  console.log(" R", resistanceFromSteps(g))
  const ahEnd = g.ah[g.ah.length-1]; console.log(' Ah total', ahEnd.toFixed(2), 'logged', JSON.stringify(voltageStats(g.volts,g.enabled)))
  const R = resistanceFromSteps(g)!.ohms
  console.log(' ocv', ocvCurve(g, R, 0.5).map(p=>`${p.ah}:${p.volts.toFixed(2)}`).join(' '))
  const pred = new Float64Array(g.t.length); for (let i=0;i<pred.length;i++) pred[i]=fit.v0-fit.kVoltsPerAh*g.ah[i]-fit.r0Ohms*g.amps[i]
  console.log(' model nochange', JSON.stringify(voltageStats(pred,g.enabled)))
  for (const cap of [60,40,30]) console.log(' cap', cap, JSON.stringify(replayCap(g,fit,'Flywheel',cap,'clip')), JSON.stringify(replayCap(g,fit,'Flywheel',cap,'defer')))
  // rest voltage just before auto
  const a0 = m.auto[0].start; const vs:number[]=[]; for(let i=0;i<g.t.length;i++) if(g.t[i]>a0-2&&g.t[i]<a0) vs.push(g.volts[i]); vs.sort(); console.log(' rest', vs[vs.length>>1])
  // OCV at 160s after auto enable
  for (const dt of [100,160]) { const i = Math.round((a0+dt-g.t[0])/0.02); const w:number[]=[]; for(let j=i-25;j<i+25;j++) w.push(g.volts[j]+R*g.amps[j]); w.sort((a,b)=>a-b); console.log(' ocv@',dt, w[25].toFixed(2), 'ah', g.ah[i].toFixed(2), 'I', g.amps[i].toFixed(0)) }
}
