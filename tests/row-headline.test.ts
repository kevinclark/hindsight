import { describe, expect, it } from 'vitest'
import { rowHeadline, shortTitle } from '../src/report/titles.ts'
import type { Finding } from '../src/rules/types.ts'

const base = (over: Partial<Finding>): Finding =>
  ({ rule: 'power/pdp-breaker-margin', title: 'Test reason at 2:38 into the match (teleop; robot time 507.1 s)', about: null, when: null, evidence: { n: 1 }, ...over }) as unknown as Finding

describe('rowHeadline', () => {
  it('leads with the rule short title', () => {
    expect(rowHeadline(base({})).lead).toBe("Close to tripping a motor's breaker")
  })
  it('falls back to the card title when the rule has none', () => {
    expect(rowHeadline(base({ rule: 'no/such-rule' })).lead).toBe('Test reason at 2:38 into the match')
  })
  it('shows about unless the lead already contains it', () => {
    expect(rowHeadline(base({ about: 'Intake' })).about).toBe('Intake')
    expect(rowHeadline(base({ about: 'MOTOR' })).about).toBe('')
    expect(rowHeadline(base({ about: null })).about).toBe('')
  })
  it('takes the key only from measured, with and without a threshold', () => {
    expect(rowHeadline(base({ measured: [{ label: 'lowest voltage while enabled', value: 6.26, unit: 'V', threshold: 7 }] })).key).toBe('6.26 V lowest voltage while enabled (line 7 V)')
    expect(rowHeadline(base({ measured: [{ label: 'times', value: 3, unit: '' }] })).key).toBe('3 times')
    expect(rowHeadline(base({ evidence: { 'devices dropped': 2 } })).key).toBe('')
  })
  it('compacts the time four ways', () => {
    const t = (when: string | null) => rowHeadline(base({ when })).time
    expect(t('2:38 into the match (teleop; robot time 507.1 s)')).toBe('2:38 teleop')
    expect(t('0:00 into the match (auto; robot time 270.9 s)')).toBe('0:00 auto')
    expect(t('0:12 into run 3 of 7 (teleop; robot time 40.0 s)')).toBe('run 3 · 0:12 teleop')
    expect(t('for the whole match, twice')).toBe('for the whole match')
    expect(t(null)).toBe('')
  })
})

describe('shortTitle cut at " (first at "', () => {
  it('stops before a parenthesised first-at aside', () => {
    expect(shortTitle('Camera saw nothing for 4 frames (first at 0:30 into the match (auto; robot time 1.0 s))')).toBe('Camera saw nothing for 4 frames')
  })
})
