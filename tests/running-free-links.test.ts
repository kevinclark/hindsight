// mech/motor-running-free explains a steady-speed mech/follower-mismatch on the same group (links.ts), and not a stopped follower.
import { describe, expect, it } from 'vitest'
import { LINKS } from '../src/rules/index.ts'
import { consolidate } from '../src/rules/run.ts'
import type { Finding } from '../src/rules/types.ts'

const finding = (rule: string, about: string, evidence: Finding['evidence'] = {}): Finding => ({
  rule, severity: 'warning', title: `${rule} ${about}`, time: 20, matchTime: null, when: null, about, key: `${rule} · ${about}`,
  evidence, meaning: '', causes: [], nextStep: '',
})

describe('motor-running-free explains follower-mismatch', () => {
  it('on the same group, for a steady-speed mismatch', () => {
    const free = finding('mech/motor-running-free', 'Belt')
    const mismatch = finding('mech/follower-mismatch', 'Belt', { 'steady seconds compared': 7.5 })
    consolidate([free, mismatch], { links: LINKS })
    expect(mismatch.explainedBy?.rule).toBe('mech/motor-running-free')
    expect(free.explainedBy).toBeUndefined()
  })
  it('not on another group', () => {
    const mismatch = finding('mech/follower-mismatch', 'Other', { 'steady seconds compared': 7.5 })
    consolidate([finding('mech/motor-running-free', 'Belt'), mismatch], { links: LINKS })
    expect(mismatch.explainedBy).toBeUndefined()
  })
  it('not for a stopped follower', () => {
    const mismatch = finding('mech/follower-mismatch', 'Belt', { 'stopped follower': 'Belt 1' })
    consolidate([finding('mech/motor-running-free', 'Belt'), mismatch], { links: LINKS })
    expect(mismatch.explainedBy).toBeUndefined()
  })
})
