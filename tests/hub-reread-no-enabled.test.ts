// A log that records no Enabled signal (another team's robot) was read as "0 runs" by an earlier build (ADR 8's reading), which
// held it back from sync (ADR 15). Reading it again with this build must take that reading away. Invented data (event TEST).
process.env.TZ = 'America/Los_Angeles'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { describeFile, type Described } from '../src/hub/describe-file.ts'
import { describeLog } from '../src/hub/describe.ts'
import { ingest, localFolderFiles } from '../src/hub/ingest.ts'
import { LocalLibrary } from '../src/hub/library-store.ts'
import { redescribe } from '../src/hub/redescribe.ts'
import { neverEnabled } from '../src/hub/sync.ts'
import { robotLog } from './helpers/hub-logs.ts'

const CLOCK = Date.UTC(2026, 9, 17, 19, 0, 0)
let work: string
beforeAll(async () => { work = await mkdtemp(join(tmpdir(), 'hindsight-noenable-')) })
afterAll(() => rm(work, { recursive: true, force: true }))

describe('a log with no Enabled signal', () => {
  it('has no runs reading, while a log that records Enabled and never sets it has 0 runs', () => {
    expect(describeLog('a.wpilog', robotLog({ clockMs: CLOCK })).runs).toBeUndefined()
    expect(describeLog('b.wpilog', robotLog({ clockMs: CLOCK, neverEnabled: true })).runs).toEqual({ count: 0, seconds: [] })
  })

  it('loses a stale "0 runs" reading when read again', async () => {
    const source = join(work, 'source')
    await mkdir(source)
    await writeFile(join(source, 'other-team.wpilog'), robotLog({ clockMs: CLOCK, event: 'TEST', seed: 'other' }))
    const lib = await LocalLibrary.open(join(work, 'library'), 'm1')
    // Filed by an earlier build: the first reading carries runs { count: 0 }.
    const old = async (path: string, name: string): Promise<Described> => { const d = await describeFile(path, name); return { ...d, meta: { ...d.meta, runs: { count: 0, seconds: [] } } } }
    await ingest(lib, await localFolderFiles(source), { describe: old })
    expect(neverEnabled(lib.catalog.all()[0])).toBe(true)
    await redescribe(lib, { describer: '9.9.9+test', describe: describeFile })
    const r = lib.catalog.all()[0]
    expect(r.runs ?? null).toBeNull()
    expect(neverEnabled(r)).toBe(false)
    expect((await LocalLibrary.open(join(work, 'library'), 'm1')).catalog.all()[0].runs ?? null).toBeNull() // and after a reopen
  })
})
