import { describe, expect, it } from 'vitest'
import { currentStatus, mergeHistory, parseHistory, serializeHistory, type IssueEvent } from '../src/triage/history.ts'

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
})
