import { readFileSync } from 'node:fs'
import { openWpilog, readNumbers, readValues } from '../src/readers/wpilog.ts'
import { readDslog, dslogEndEpoch } from '../src/readers/dslog.ts'
const log = openWpilog(new Uint8Array(readFileSync(process.argv[2])))
const ep = readNumbers(log, '/SystemStats/EpochTimeMicros')!
const valid = readNumbers(log, '/SystemStats/SystemTimeValid')!
console.log('timevalid', Array.from(valid.t).map((t,i)=>[t.toFixed(2),valid.v[i]]))
const offs:number[]=[]; for(let i=0;i<ep.t.length;i+=500) offs.push(ep.v[i]/1e6-ep.t[i])
console.log('offsets sample', offs.slice(0,3), offs.slice(-3), new Date(offs.at(-1)!*1000).toISOString())
if (process.argv[3]) {
  const ds = readDslog(new Uint8Array(readFileSync(process.argv[3])))
  const off = offs.at(-1)!
  console.log('ds start', new Date(ds.startEpochSeconds*1000).toISOString(), 'wpilog t', (ds.startEpochSeconds-off).toFixed(2), 'end t', (dslogEndEpoch(ds)-off).toFixed(2), 'n', ds.records.length)
  const firstRobot = ds.records.findIndex(r=>r.voltage!==null)
  console.log('first robot', (ds.records[firstRobot].epochSeconds-off).toFixed(2))
  let lastRobot=-1; ds.records.forEach((r,i)=>{if(r.voltage!==null) lastRobot=i})
  console.log('last robot', (ds.records[lastRobot].epochSeconds-off).toFixed(2), ds.records.slice(-3))
  const tr = ds.records.map((r,i)=>[(r.epochSeconds-off).toFixed(2), r.dsAuto, r.dsTeleop, r.dsDisabled, r.robotAuto, r.robotTeleop, r.robotDisabled])
  let prev=''; for(const x of tr){const k=x.slice(1).join(); if(k!==prev){console.log(x.join(' ')); prev=k}}
}
