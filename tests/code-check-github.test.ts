import { describe, expect, it } from 'vitest'
import { annotation, countsLine, crashNotice, escapeData, escapeProperty, summary, type Marked } from '../src/code/check/github-format.ts'

const found = (over: Partial<Marked> = {}): Marked => ({
  rule: 'code/integer-division', title: 'Whole-number division', file: 'src/A.java', line: 7, message: '50 / 12 is 4 (-4.0 %)',
  evidence: {}, meaning: '', nextStep: 'Write 50.0 / 12.', isNew: true, ...over,
})

describe('workflow command escaping (as actions/toolkit does)', () => {
  it('data: % then CR and LF', () => {
    expect(escapeData('100 %\r\nnext: a,b')).toBe('100 %25%0D%0Anext: a,b')
  })
  it('properties also escape : and ,', () => {
    expect(escapeProperty('C:\\a,b\n%')).toBe('C%3A\\a%2Cb%0A%25')
  })
})

describe('annotation', () => {
  it('a new finding is a warning, with the percent sign escaped', () => {
    expect(annotation(found())).toBe('::warning file=src/A.java,line=7,title=Whole-number division (code/integer-division)::50 / 12 is 4 (-4.0 %25)')
  })
  it('an old finding, and one that was not compared, are notices', () => {
    expect(annotation(found({ isNew: false }))).toMatch(/^::notice /)
    expect(annotation(found({ isNew: null }))).toMatch(/^::notice /)
  })
  it('a crashed rule is a notice that says it is not the robot code', () => {
    expect(crashNotice('code/x', 'boom')).toBe('::notice title=Code check rule code/x crashed::boom (a bug in Hindsight, not in your code)')
  })
})

describe('summary', () => {
  const link = { blob: 'https://github.com/o/r/blob/abc', sameText: new Set(['src/A.java']) }

  it('counts line, then a table with a linked file:line', () => {
    const text = summary([found(), found({ isNew: false, file: 'src/B.java', line: 3 })], 1, link, null)
    expect(text).toContain('2 findings, 1 new in this change, 1 fixed.')
    expect(text).toContain('[`src/A.java:7`](https://github.com/o/r/blob/abc/src/A.java#L7)')
    expect(text).toContain('[`src/B.java:3`](https://github.com/o/r/blob/abc/src/B.java)')    // text differs at the link: no line
    expect(text).toContain('context for the team, not a verdict')
  })
  it('without a base: says so, and each finding reads "not compared"', () => {
    const text = summary([found({ isNew: null })], null, link, 'Not compared with abc1234: the base is not here')
    expect(text).toContain('1 finding.')
    expect(text).toContain('Not compared with abc1234')
    expect(text).toContain('| not compared |')
  })
  it('keeps a message from breaking the table or adding HTML', () => {
    const text = summary([found({ message: 'a | b <script>\nnext *x*' })], 0, { blob: null, sameText: new Set() }, null)
    expect(text).toContain('a \\| b &lt;script&gt; next \\*x\\*')
  })
  it('countsLine', () => {
    expect(countsLine([found(), found({ isNew: false })], 2)).toBe('2 findings, 1 new in this change, 2 fixed')
    expect(countsLine([found()], null)).toBe('1 finding')
  })
})
