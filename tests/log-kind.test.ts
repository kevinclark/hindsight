// What an off-the-field robot log is: an on-check (enabled for a second or more), not enabled, or not read yet. Invented data only.
import { describe, expect, it } from 'vitest'
import { enabledSeconds, offFieldKind } from '../src/hub/log-kind.ts'
import type { LogRecord } from '../src/hub/types.ts'

const rec = (over: Partial<LogRecord>): Pick<LogRecord, 'kind' | 'onField' | 'runs'> => ({ kind: 'wpilog', onField: false, ...over })

describe('offFieldKind', () => {
  it('is an on-check when some run is a second or longer', () => {
    expect(offFieldKind(rec({ runs: { count: 2, seconds: [0.4, 1] } }))).toBe('on-check')
    expect(offFieldKind(rec({ runs: { count: 1, seconds: [34.2] } }))).toBe('on-check')
  })
  it('is not enabled when it has runs and none reaches a second (or has none)', () => {
    expect(offFieldKind(rec({ runs: { count: 0, seconds: [] } }))).toBe('not-enabled')
    expect(offFieldKind(rec({ runs: { count: 2, seconds: [0.2, 0.99] } }))).toBe('not-enabled')
  })
  it('is unread when the record has no runs', () => {
    expect(offFieldKind(rec({}))).toBe('unread')
  })
  it('is null on the field, and for anything but a robot .wpilog', () => {
    expect(offFieldKind(rec({ onField: true, runs: { count: 1, seconds: [150] } }))).toBeNull()
    expect(offFieldKind(rec({ kind: 'dslog' }))).toBeNull()
    expect(offFieldKind(rec({ kind: 'hoot' }))).toBeNull()
  })
})

describe('enabledSeconds', () => {
  it('sums the runs of a second or more', () => {
    expect(enabledSeconds(rec({ runs: { count: 3, seconds: [12.5, 0.5, 20] } }))).toBe(32.5)
    expect(enabledSeconds(rec({}))).toBe(0)
  })
})
