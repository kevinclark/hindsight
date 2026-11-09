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
    expect(rowHeadline(base({ measured: [{ label: 'lowest voltage while enabled', value: 6.26, unit: 'V', threshold: 7 }] })).key).toBe('6.26 V (line 7 V)')
    expect(rowHeadline(base({ measured: [{ label: 'times', value: 3, unit: '' }] })).key).toBe('3 times')
    expect(rowHeadline(base({ evidence: { 'devices dropped': 2 } })).key).toBe('')
    expect(rowHeadline(base({ measured: [{ label: 'brownouts', one: 'brownout', value: 1, unit: '' }] })).key).toBe('1 brownout')
    expect(rowHeadline(base({ measured: [{ label: 'brownouts', one: 'brownout', value: 3, unit: '' }] })).key).toBe('3 brownouts')
    expect(rowHeadline(base({ measured: [{ label: 'main breaker heat, fast edge', short: 'of a fast trip', value: 156, unit: '%', threshold: 100 }] })).key).toBe('156 % of a fast trip (line 100 %)')
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

describe('rowHeadline keeps what made the finding fire', () => {
  const limit = (on: string) => base({ measured: [{ label: 'peak supply current', value: 67, unit: 'A', threshold: 48 }], evidence: { 'configured limit (A)': 40, 'limit switched on in code': on } })
  it('a current limit: the configured limit, and off in code when it is', () => {
    expect(rowHeadline(limit('no (as of main abc1234; this log ran def5678)')).key).toBe('67 A against a 40 A limit, off in code')
    expect(rowHeadline(limit('yes (as of main abc1234; this log ran def5678)')).key).toBe('67 A against a 40 A limit')
  })
  const stale = (value: number, drops: number) => base({ measured: [{ label: 'stale share of the match', value, unit: '%', threshold: 15 }], evidence: { 'stale share of the match (%)': value, 'dropouts during the match': drops, 'seconds disconnected': 5.6 } })
  it('a camera dropout: the dropouts, the share only when past its line', () => {
    expect(rowHeadline(stale(13.7, 1)).key).toBe('dropped out 1 time, 5.6 s disconnected')
    expect(rowHeadline(stale(24.9, 2)).key).toBe('dropped out 2 times, 5.6 s disconnected · 24.9 % stale (line 15 %)')
    expect(rowHeadline(stale(20, 0)).key).toBe('20 % (line 15 %)')
  })
  it('an alert seen only before or after the match says so in the time slot', () => {
    expect(rowHeadline(base({ evidence: { 'times during the match': 0, 'times before or after the match': 1 } })).time).toBe('before/after the match')
    expect(rowHeadline(base({ evidence: { 'times across the 3 runs': 0, 'times before or after the match': 2 } })).time).toBe('before/after the match')
    expect(rowHeadline(base({ when: '1:21 into the match (teleop; robot time 399.4 s)', evidence: { 'times during the match': 1, 'times before or after the match': 0 } })).time).toBe('1:21 teleop')
  })
})

describe('shortTitle cut at " (first at "', () => {
  it('stops before a parenthesised first-at aside', () => {
    expect(shortTitle('Camera saw nothing for 4 frames (first at 0:30 into the match (auto; robot time 1.0 s))')).toBe('Camera saw nothing for 4 frames')
  })
})
