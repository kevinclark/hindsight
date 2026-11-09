// A log's Driver Station files read beside it in the Session view: its summary runs the DS rules, and the saved
// summary's key names the DS files too, so one read before they were attached is not reused.
import { describe, expect, it } from 'vitest'
import { offseason2026 } from '../src/profiles/2026-offseason.ts'
import { summarizeLog } from '../src/session/summary.ts'
import { fileKey } from '../src/session/cache.ts'
import { loadFixture } from './helpers/load.ts'

describe('a session summary with the DS log beside the robot log', () => {
  const [wpilog, dslog] = loadFixture('auto-and-comms')
  it('runs comms/ds-log-truncated only when the DS log comes beside it', () => {
    expect(summarizeLog(wpilog, offseason2026)!.rules['comms/ds-log-truncated'].status).toBe('not checked')
    const s = summarizeLog(wpilog, offseason2026, undefined, undefined, [dslog])!
    expect(s.rules['comms/ds-log-truncated'].status).toBe('fired')
    expect(s.fileName).toBe(wpilog.name)
    expect(s.problems).toEqual([])
  })
})

describe('the saved summary key', () => {
  const log = { name: 'q1.wpilog', size: 10, lastModified: 5 }
  const ds = { name: 'q1.dslog', size: 3, lastModified: 6 }
  it('is unchanged for a log read alone, so summaries saved before stay usable', () => {
    expect(fileKey(log)).toBe('q1.wpilog|10|5')
    expect(fileKey(log, [])).toBe('q1.wpilog|10|5')
  })
  it('changes when a DS file comes beside the log', () => {
    expect(fileKey(log, [ds])).not.toBe(fileKey(log))
    expect(fileKey(log, [ds])).not.toBe(fileKey(log, [{ ...ds, size: 4 }]))
  })
})
