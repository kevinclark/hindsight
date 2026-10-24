import { describe, expect, it } from 'vitest'
import { buildBoard } from '../src/board/model.ts'
import { changedLine, dueLine, ownerText, priorityWord, rowTitle, statusLine, tags } from '../src/board/words.ts'
import type { BoardEvent } from '../src/triage/history.ts'
import { ROBOT, input, match, session } from './helpers/board-scene.ts'

const D = 'power/brownout'
const line = (op: BoardEvent['op'], value: string, o: Partial<BoardEvent> = {}): BoardEvent => ({ type: 'board', v: 1, key: D, robot: ROBOT, op, value, by: { device: 'd', role: 'software' }, seq: 1, when: '2099-03-05T17:00:00Z', ...o })
const s = session([2, 3, 4, 5].map((n) => match(n, { fires: n >= 4 ? [{ key: D }] : [], quiet: n >= 4 ? [] : [D] })))

describe('board wording', () => {
  it('a deferred row says what holds and when it is decided again, never "Deferred until" or "Due"', () => {
    const b = buildBoard(input(s, [line('workaround', 'test workaround'), line('defer', 'gap', { seq: 2, until: { kind: 'gap', match: 'Q7' } })]))
    const i = b.issues[0]
    expect(statusLine(i)).toBe('Workaround until the gap after Q7 (overnight) · re-decide in that gap')
    expect(statusLine(i)).not.toMatch(/Deferred until|Due/)
    expect(dueLine(i)).toBe('')
    const next = buildBoard(input(s, [line('workaround', 'x'), line('defer', 'next-match', { seq: 2, until: { kind: 'next-match', match: 'Q6' } })])).issues[0]
    expect(statusLine(next)).toBe('Workaround until Q6 · re-decide at Q6')
  })
  it('an open row has a status word, a due line, its owner alone and its last change', () => {
    let i = buildBoard(input(s)).issues[0]
    expect([statusLine(i), dueLine(i), ownerText(i), changedLine(i), priorityWord(i)]).toEqual(['Open', 'Due before Q6', 'no owner yet', 'Not changed yet', 'Red'])
    i = buildBoard(input(s, [line('owner', 'pit'), line('note', 'test reason', { seq: 2, match: 'TEST Qualification 5' })])).issues[0]
    expect([ownerText(i), changedLine(i)]).toEqual(['pit', 'Last changed Q5 by software'])
    expect(rowTitle(i)).toBe('Power · roboRIO brownout')
  })
  it('a grey row shows no due point; it asks instead', () => {
    const grey = session([2, 3, 4, 5, 6].map((n) => match(n, { fires: n === 2 ? [{ key: D }] : [], quiet: n === 2 ? [] : [D] })))
    const i = buildBoard(input(grey)).issues[0]
    expect([i.grey, dueLine(i), i.greyAsk]).toEqual([true, '', 'Not seen for 4 matches: close it, or give it an owner?'])
    expect(priorityWord(i)).toBe('Grey')
  })
  it('tags: came back, and a mentor\'s change', () => {
    const i = buildBoard(input(s, [line('note', 'test reason', { by: { device: 'd', role: 'mentor' } })])).issues[0]
    expect(tags(i)).toEqual(['Last change by mentor'])
  })
})
