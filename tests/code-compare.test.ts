import { describe, expect, it } from 'vitest'
import { compareFindings, type Side } from '../src/code/check/compare.ts'
import type { CodeFinding } from '../src/code/check/rule.ts'

// Invented Java: one finding per `/` line, on the line the finding names.
const finding = (file: string, line: number, message = 'm'): CodeFinding => ({
  rule: 'code/integer-division', title: 't', file, line, message, evidence: {}, meaning: '', nextStep: '',
})
const side = (files: Record<string, string[]>, ...found: [string, number, string?][]): Side => ({
  files: Object.entries(files).map(([path, lines]) => ({ path, text: lines.join('\n') })),
  findings: found.map(([file, line, message]) => finding(file, line, message)),
})

describe('compareFindings', () => {
  it('a finding whose line only moved is not new', () => {
    const base = side({ 'A.java': ['double a = 50 / 12;'] }, ['A.java', 1])
    const head = side({ 'A.java': ['// a new comment', '', '  double a = 50 / 12;  '] }, ['A.java', 3])
    expect(compareFindings(head, base)).toMatchObject({ findings: [{ isNew: false }], fixed: 0 })
  })

  it('the same line with a changed ID is one new and one fixed', () => {
    const base = side({ 'A.java': ['new TalonFX(5);'] }, ['A.java', 1])
    const head = side({ 'A.java': ['new TalonFX(6);'] }, ['A.java', 1])
    expect(compareFindings(head, base)).toMatchObject({ findings: [{ isNew: true }], fixed: 1 })
  })

  it('two identical lines match pairwise: a third is the new one', () => {
    const line = 'double a = 7 / 2;'
    const base = side({ 'A.java': [line, line] }, ['A.java', 1], ['A.java', 2])
    const head = side({ 'A.java': [line, line, line] }, ['A.java', 1], ['A.java', 2], ['A.java', 3])
    const result = compareFindings(head, base)
    expect(result.findings.filter((f) => f.isNew)).toHaveLength(1)
    expect(result.fixed).toBe(0)
  })

  it('two identical lines down to one: one fixed, none new', () => {
    const line = 'double a = 7 / 2;'
    const base = side({ 'A.java': [line, line] }, ['A.java', 1], ['A.java', 2])
    const head = side({ 'A.java': [line] }, ['A.java', 1])
    expect(compareFindings(head, base)).toMatchObject({ findings: [{ isNew: false }], fixed: 1 })
  })

  it('a moved file is one new and one fixed (accepted: rare)', () => {
    const line = 'double a = 7 / 2;'
    const base = side({ 'old/A.java': [line] }, ['old/A.java', 1])
    const head = side({ 'new/A.java': [line] }, ['new/A.java', 1])
    expect(compareFindings(head, base)).toMatchObject({ findings: [{ isNew: true }], fixed: 1 })
  })

  it('the message is not part of the key', () => {
    const base = side({ 'A.java': ['x'] }, ['A.java', 1, 'also at B.java:10'])
    const head = side({ 'A.java': ['x'] }, ['A.java', 1, 'also at B.java:12'])
    expect(compareFindings(head, base)).toMatchObject({ findings: [{ isNew: false }], fixed: 0 })
  })

  it('no base findings: all new; no head findings: all fixed', () => {
    const some = side({ 'A.java': ['x', 'y'] }, ['A.java', 1], ['A.java', 2])
    const none = side({ 'A.java': ['x', 'y'] })
    expect(compareFindings(some, none).findings.every((f) => f.isNew)).toBe(true)
    expect(compareFindings(none, some)).toMatchObject({ findings: [], fixed: 2 })
  })
})
