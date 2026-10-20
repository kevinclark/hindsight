import { describe, expect, it } from 'vitest'
import { shortMatchLabel } from '../src/ui/match-label.ts'

describe('shortMatchLabel', () => {
  it('maps each match type explicitly, so Practice and Playoff never share a letter', () => {
    const cases: [string, string][] = [
      ['Qualification 13', 'Q13'], ['Practice 2', 'Pr2'], ['Playoff 4', 'Pl4'], ['Quarterfinal 1', 'QF1'],
      ['Semifinal 2', 'SF2'], ['Final 1', 'F1'], ['Elimination 3', 'E3'],
    ]
    for (const [label, short] of cases) expect(shortMatchLabel(label, 0)).toBe(short)
    expect(new Set(cases.map(([l]) => shortMatchLabel(l, 0))).size).toBe(cases.length)
  })
  it('uses the first letters of an unknown type, and keeps the number', () => {
    expect(shortMatchLabel('Showcase 5', 0)).toBe('S5')
    expect(shortMatchLabel('Exhibition Round 7', 0)).toBe('ER7')
  })
  it('keeps the position for a log with no label', () => {
    expect(shortMatchLabel('', 0)).toBe('#1')
    expect(shortMatchLabel('  ', 4)).toBe('#5')
  })
})
