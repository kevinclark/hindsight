import { describe, expect, it } from 'vitest'
import { currentStatus, lastPassingSha, matchKey, mergeHistory, parseHistory, serializeHistory, triage, type IssueEvent, type PitCheckEvent } from '../src/triage/history.ts'

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

describe('"not a real problem" marks', () => {
  const wrong: IssueEvent = { type: 'issue', key: 'auto/early-disable', status: 'wrong', note: 'test reason', when: '2026-10-20T10:00:00Z', match: 'TEST Qualification 2', event: 'TEST', played: '2026-10-17T17:00:00Z' }
  it('round-trip, and a file written before them still reads the same', () => {
    expect(parseHistory(serializeHistory([known, wrong])).events).toEqual([known, wrong])
    const old = `${JSON.stringify({ type: 'issue', key: 'k', status: 'known', note: 'n', when: '2026-01-01T00:00:00Z' })}\n`
    expect(parseHistory(old)).toEqual({ events: [{ type: 'issue', key: 'k', status: 'known', note: 'n', when: '2026-01-01T00:00:00Z' }], skipped: 0 })
  })
  it('a wrong mark with no match is skipped: it would have nothing to apply to', () => {
    const { match: _m, ...noMatch } = wrong
    expect(parseHistory(JSON.stringify(noMatch)).skipped).toBe(1)
  })
  it('is about its own match only and leaves the issue\'s known or fixed mark alone', () => {
    const t = triage([known, wrong, { ...wrong, key: known.key, when: '2026-10-20T11:00:00Z' }])
    expect(t.issues.get(known.key)?.status).toBe('known')
    expect([...t.wrong.keys()]).toEqual([matchKey('auto/early-disable', 'TEST Qualification 2'), matchKey(known.key, 'TEST Qualification 2')])
    expect(currentStatus([wrong]).size).toBe(0)
  })
  it('a later known or fixed mark on the same match replaces it; on another match it does not', () => {
    const later = '2026-10-21T00:00:00Z'
    expect(triage([wrong, { ...wrong, status: 'known', note: 'real after all', when: later }]).wrong.size).toBe(0)
    expect(triage([wrong, { ...wrong, status: 'known', when: later, match: 'TEST Qualification 7' }]).wrong.size).toBe(1)
  })
  it('"unmark" undoes only the wrong mark; "new" clears the issue everywhere, as before', () => {
    const k: IssueEvent = { ...known, key: wrong.key, match: 'TEST Qualification 7' }
    const t = triage([k, wrong, { ...wrong, status: 'unmark', note: '', when: '2026-10-21T00:00:00Z' }])
    expect(t.wrong.size).toBe(0)
    expect(t.issues.get(wrong.key)?.status).toBe('known')
    const n = triage([k, wrong, { ...wrong, status: 'new', note: '', when: '2026-10-21T00:00:00Z' }])
    expect([n.wrong.size, n.issues.size]).toEqual([0, 0])
  })
  it('a build from before wrong marks skips both new lines, so an undo never clears a known issue there', () => {
    const before = (text: string) => text.split('\n').filter((l) => l && ['known', 'fixed', 'new'].includes(JSON.parse(l).status))
    expect(before(serializeHistory([wrong, { ...wrong, status: 'unmark' }]))).toEqual([])
  })
})
