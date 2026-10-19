import { readFileSync } from 'node:fs'
import { openWpilog } from '../src/readers/wpilog.ts'
const log = openWpilog(new Uint8Array(readFileSync(process.argv[2])))
const re = new RegExp(process.argv[3] ?? '.')
for (const e of log.entries.values()) if (re.test(e.name)) console.log(e.name, '|', e.type, '|', log.entryStart[e.id+1]-log.entryStart[e.id])
