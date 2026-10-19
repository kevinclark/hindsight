// The team's pit checklist as Foresight marks it: from the current check only, "by eye" never OK, and the verdict
// itself untouched by the list.
import { describe, expect, it } from 'vitest'
import { markOnchecks, ONCHECKS } from '../src/foresight/onchecks.ts'
import { verdictFor } from '../src/foresight/verdict.ts'
import type { Report } from '../src/rules/index.ts'

const finding = (rule: string, severity: 'warning' | 'info', title = rule) => ({ rule, severity, title, time: null, matchTime: null, when: null, about: null, key: rule, evidence: {}, meaning: '', causes: [], nextStep: '' })
const proven = { 'power/rest-voltage': { logs: 9, fires: 1, base: 'x', date: 'd' } }
const state = (marked: ReturnType<typeof markOnchecks>, line: string) => marked.find((l) => l.line === line)!.state

describe('the team\'s pit checklist in Foresight', () => {
  it('with no current check, nothing is OK; by-eye and not-yet lines say so', () => {
    const marked = markOnchecks(null)
    expect(marked.length).toBe(ONCHECKS.length)
    expect(marked.some((l) => l.state === 'ok')).toBe(false)
    expect(state(marked, 'Correct auto selected in Elastic')).toBe('by eye')
    expect(state(marked, 'Log stick in')).toBe('not yet')
    expect(state(marked, 'Fresh battery installed')).toBe('not checked')
  })

  it('marks lines from the verdict: red, amber, context, OK, and not checked when no covering check ran', () => {
    const report: Report = {
      findings: [finding('power/rest-voltage', 'warning', 'Battery rested at 12.45 V'), finding('build/dirty', 'warning'), finding('foresight/gyro-still-drift', 'info', 'Gyro moved 0.02°')],
      skipped: [{ rule: 'foresight/zero-sanity', reason: 'missing /Intake/Pivot/PositionRotations' }],
      crashed: [],
    }
    const verdict = verdictFor(report, proven)
    const marked = markOnchecks({ verdict, report })
    expect(state(marked, 'Fresh battery installed')).toBe('red')
    expect(state(marked, 'No undeployed changes')).toBe('amber')
    expect(state(marked, 'Gyro seems normal')).toBe('context')
    expect(state(marked, 'No alerts on Elastic')).toBe('ok')
    expect(state(marked, 'Mechanisms zeroed')).toBe('not checked')
    expect(marked.filter((l) => l.byEye).every((l) => l.state === 'by eye')).toBe(true)
    // The list is a view: the verdict is what verdictFor said, nothing more.
    expect(verdict.verdict).toBe('NO-GO')
  })
})
