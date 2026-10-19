import { describe, expect, it } from 'vitest'
import { currentStatus, lastPassingSha, mergeHistory, parseHistory, serializeHistory, type IssueEvent, type PitCheckEvent } from '../src/triage/history.ts'

const known: IssueEvent = { type: 'issue', key: 'mech/follower-mismatch · Flywheel', status: 'known', note: 'belt slip on 17/18', when: '2026-10-17T21:30:00Z', match: 'Q21' }
const fixed: IssueEvent = { ...known, status: 'fixed', note: 'new belt before elims', when: '2026-10-18T15:00:00Z' }

describe('known-issue history file', () => {
  it('round-trips through the text file', () => {
    expect(parseHistory(serializeHistory([known, fixed])).events).toEqual([known, fixed])
  })
  it('skips lines it does not understand instead of failing', () => {
    const r = parseHistory(`${JSON.stringify(known)}\nnot json\n{"type":"metrics"}\n`)
    expect(r.events).toEqual([known])
    expect(r.skipped).toBe(2)
  })
  it('newest line wins, whatever order the files were combined in', () => {
    expect(currentStatus([fixed, known]).get(known.key)?.status).toBe('fixed')
  })
  it('"new" clears an issue', () => {
    expect(currentStatus([known, { ...known, status: 'new', when: '2026-10-19T00:00:00Z' }]).has(known.key)).toBe(false)
  })
  it('merging two laptops\' files keeps one copy of shared lines', () => {
    expect(mergeHistory([known], [known, fixed])).toEqual([known, fixed])
  })
  it('carries Foresight pit checks; the last GO one gives the code to compare against', () => {
    const go: PitCheckEvent = { type: 'pit-check', verdict: 'GO', sha: 'aaa111', dirty: false, robot: '2026 offseason robot @ main', when: '2026-10-18T15:00:00Z' }
    const nogo: PitCheckEvent = { ...go, verdict: 'NO-GO', sha: 'bbb222', when: '2026-10-18T16:00:00Z' }
    const read = parseHistory(serializeHistory([known, go, nogo]))
    expect(read).toEqual({ events: [known, go, nogo], skipped: 0 })
    expect(lastPassingSha(read.events)).toBe('aaa111')
    expect(currentStatus(read.events).size).toBe(1)
    expect(lastPassingSha([known])).toBeNull()
  })
})
