// The power map screen's logic (src/power/power-map-view.ts): layout, editing, the popover's walk, problems, the strip's words.
import { describe, expect, it } from 'vitest'
import { applyToAll, emptyMap, feedLabel, mapLine, mapProblems, mpmAt, nextEmptySlot, PDP_ROWS, placedCount, shortName, slotEntries, slotRows, slotsKeeping, stripText, unplacedMotors, withExtraFeed, withSlot } from '../src/power/power-map-view.ts'
import { breakerForMotor, type Feed, type PowerMap } from '../src/power/power-map.ts'

const REV40 = { family: 'rev-ato', ratingA: 40 } as const
const motor = (name: string, canId?: number): Feed => ({ kind: 'motor', name, ...(canId !== undefined ? { canId } : {}) })
const MOTORS = [{ name: 'Front Left drive', canId: 3 }, { name: 'Front Right drive', canId: 5 }, { name: 'Intake right', canId: 16 }]
const base = () => emptyMap('Test robot @ main', '2026-11-08T10:00:00.000Z')

describe('the drawing', () => {
  it('numbers the top row 0 to 11 from the + stud (right to left) and the bottom row 12 to 23 left to right', () => {
    expect(PDP_ROWS[0]).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    expect(PDP_ROWS[1]).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])
    expect([...PDP_ROWS[0], ...PDP_ROWS[1]].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i))
  })
  it('rotated 180° swaps the rows and reverses each; twice is the original', () => {
    const turned = slotRows(true)
    expect(turned[0]).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12])
    expect(turned[1]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(slotRows(false)).toEqual(PDP_ROWS)
  })
  it('names a feed with its CAN ID, never a bare number', () => {
    expect(feedLabel(motor('Front Left drive', 3), true)).toBe('FL drive · CAN 3')
    expect(feedLabel(motor('Front Left drive', 3))).toBe('Front Left drive · CAN 3')
    expect(feedLabel(motor('Hood'))).toBe('Hood')
    expect(feedLabel({ kind: 'radio' })).toBe('Radio')
    expect(feedLabel({ kind: 'other', label: 'Vision' })).toBe('Vision')
    expect(feedLabel({ kind: 'mpm' }, false, 'mpm-2')).toBe('MPM 2')
    expect(shortName('Back Right steer')).toBe('BR steer')
  })
})

describe('placing a motor', () => {
  it('sets one slot and leaves the others; clearing takes the entry out', () => {
    const a = withSlot(base(), 'pdp', 7, { breaker: REV40, feeds: motor('Front Left drive', 3) })
    expect(a.boards[0].slots).toEqual([{ slot: 7, breaker: REV40, feeds: motor('Front Left drive', 3) }])
    const b = withSlot(a, 'pdp', 2, { breaker: { family: 'rev-ato', ratingA: 20 }, feeds: { kind: 'radio' } })
    expect(b.boards[0].slots.map((s) => s.slot)).toEqual([2, 7])
    expect(withSlot(b, 'pdp', 7, null).boards[0].slots.map((s) => s.slot)).toEqual([2])
    expect(base().boards[0].slots).toEqual([]) // never in place
  })
  it('a motor placed this way is found by the rules (breakerForMotor)', () => {
    const m = withSlot(base(), 'pdp', 7, { breaker: { family: 'ctre-ato', ratingA: 30 }, feeds: motor('Front Left drive', 3) })
    expect(breakerForMotor(m, 'Front Left drive', 3)).toMatchObject({ family: 'ctre-ato', ratingA: 30, slot: 7, mapped: true })
  })
  it('an MPM on a slot brings an MPM board joined to it; moving it off takes the board away', () => {
    let m = withSlot(base(), 'pdp', 4, { breaker: REV40, feeds: { kind: 'mpm' } })
    expect(m.boards.map((b) => b.id)).toEqual(['pdp', 'mpm-1'])
    expect(mpmAt(m, 4)?.fedFrom).toEqual({ board: 'pdp', slot: 4 })
    m = withSlot(m, 'mpm-1', 0, { breaker: { family: 'atm', ratingA: 10 }, feeds: motor('Climber', 30) })
    expect(breakerForMotor(m, 'Climber', 30)).toMatchObject({ board: 'mpm-1', slot: 0, family: 'atm' })
    m = withSlot(m, 'pdp', 9, { breaker: REV40, feeds: { kind: 'mpm' } })
    expect(m.boards.map((b) => b.id)).toEqual(['pdp', 'mpm-1', 'mpm-2'])
    const gone = withSlot(m, 'pdp', 4, null)
    expect(gone.boards.map((b) => b.id)).toEqual(['pdp', 'mpm-2'])
    // setting the same MPM slot again doesn't add a second board
    expect(withSlot(m, 'pdp', 4, { breaker: REV40, feeds: { kind: 'mpm' } }).boards.length).toBe(3)
  })
})

describe('the popover\'s walk: the next empty slot', () => {
  it('goes up from the slot just filled, skipping filled ones, and wraps', () => {
    let m = base()
    m = withSlot(m, 'pdp', 0, { breaker: REV40, feeds: motor('a') })
    m = withSlot(m, 'pdp', 1, { breaker: REV40, feeds: motor('b') })
    m = withSlot(m, 'pdp', 3, { breaker: null, feeds: { kind: 'radio' } })
    expect(nextEmptySlot(m, 'pdp', 1)).toBe(2)
    expect(nextEmptySlot(m, 'pdp', 2)).toBe(4)
    expect(nextEmptySlot(m, 'pdp', 23)).toBe(2)
    expect(nextEmptySlot(m, 'pdp', 0)).toBe(2)
  })
  it('is null when the board is full; an MPM walks its own six slots', () => {
    let m = base()
    for (let s = 0; s < 24; s++) m = withSlot(m, 'pdp', s, { breaker: REV40, feeds: motor(`m${s}`) })
    expect(nextEmptySlot(m, 'pdp', 5)).toBeNull()
    let p = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: { kind: 'mpm' } })
    p = withSlot(p, 'mpm-1', 5, { breaker: { family: 'atm', ratingA: 5 }, feeds: { kind: 'other' } })
    expect(nextEmptySlot(p, 'mpm-1', 4)).toBe(0)
    expect(nextEmptySlot(p, 'mpm-1', 5)).toBe(0)
  })
  it('placing 20 motors one after another, each into the slot the popover moved to, takes 20 choices', () => {
    let m = base()
    let slot = 0
    for (let i = 0; i < 20; i++) {
      m = withSlot(m, 'pdp', slot, { breaker: REV40, feeds: motor(`motor ${i}`, i) })
      slot = nextEmptySlot(m, 'pdp', slot)!
    }
    expect(m.boards[0].slots).toHaveLength(20)
    expect(slot).toBe(20)
  })
})

describe('what doesn\'t add up', () => {
  it('before any motor is placed: one line, saying the warnings still work', () => {
    const p = mapProblems(base(), MOTORS)
    expect(p.map((x) => x.kind)).toEqual(['unplaced'])
    expect(p[0].text).toBe('Motors not placed yet: the warnings still work, they just won\'t name the slot.')
    expect(mapProblems(null, MOTORS)[0].kind).toBe('unplaced')
  })
  it('after the first: one folded line, "N not placed · next: <name>"', () => {
    const m = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: motor('Front Left drive', 3) })
    expect(mapProblems(m, MOTORS).map((x) => x.text)).toEqual(['2 not placed · next: Front Right drive'])
    const done = withSlot(withSlot(m, 'pdp', 1, { breaker: REV40, feeds: motor('Front Right drive', 5) }), 'pdp', 2, { breaker: REV40, feeds: motor('Intake right', 16) })
    expect(mapProblems(done, MOTORS)).toEqual([])
  })
  it('two motors on one slot: names both, quotes R621, lights the slot', () => {
    let m = withSlot(base(), 'pdp', 5, { breaker: REV40, feeds: motor('Front Left drive', 3) })
    m = withExtraFeed(m, 'pdp', 5, { breaker: REV40, feeds: motor('Front Right drive', 5) })
    expect(slotEntries(m, 'pdp', 5)).toHaveLength(2)
    const two = mapProblems(m, MOTORS).find((x) => x.kind === 'two-motors')!
    expect(two.slots).toEqual([5])
    expect(two.text).toContain('Slot 5 feeds 2 motors (Front Left drive, Front Right drive)')
    expect(two.text).toContain('R621')
    expect(two.text).toContain('1 and only 1 circuit breaker or fuse')
  })
  it('a motor on two slots is said once, with both slots', () => {
    let m = withSlot(base(), 'pdp', 1, { breaker: REV40, feeds: motor('Intake right', 16) })
    m = withSlot(m, 'pdp', 2, { breaker: REV40, feeds: motor('Intake right', 16) })
    const twice = mapProblems(m, MOTORS).find((x) => x.kind === 'motor-twice')!
    expect(twice.slots).toEqual([1, 2])
  })
  it('a breaker over 40 A, or one the maker does not make, is not legal on a PDP channel (R619)', () => {
    let m = withSlot(base(), 'pdp', 3, { breaker: { family: 'rev-ato', ratingA: 50 }, feeds: motor('x') })
    m = withSlot(m, 'pdp', 4, { breaker: { family: 'rev-ato', ratingA: 35 }, feeds: motor('y') })
    m = withSlot(m, 'pdp', 5, { breaker: { family: 'snap-action', ratingA: 35 }, feeds: motor('z') })
    const bad = mapProblems(m, []).filter((x) => x.kind === 'illegal-breaker')
    expect(bad.map((x) => x.slots[0])).toEqual([3, 4]) // Snap Action does make a 35 A
    expect(bad[0].text).toContain("a 50 A breaker isn't legal on a PDP channel")
    expect(bad[0].text).toContain('R619')
  })
  it('no check on an MPM\'s breakers or input', () => {
    let m = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: { kind: 'mpm' } })
    m = withSlot(m, 'mpm-1', 0, { breaker: { family: 'atm', ratingA: 15 }, feeds: motor('Climber', 30) })
    expect(mapProblems(m, [{ name: 'Climber', canId: 30 }])).toEqual([])
  })
  it('counts the motors placed, by CAN ID else name', () => {
    const m = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: motor('old name', 5) })
    expect(placedCount(m, MOTORS)).toEqual({ placed: 1, total: 3 })
    expect(unplacedMotors(m, MOTORS).map((x) => x.name)).toEqual(['Front Left drive', 'Intake right'])
  })
})

describe('"every motor is on" changed after slots are placed', () => {
  const placed = () => {
    let m: PowerMap = { ...base(), usual: REV40 }
    m = withSlot(m, 'pdp', 0, { breaker: REV40, feeds: motor('Front Left drive', 3) })
    m = withSlot(m, 'pdp', 1, { breaker: REV40, feeds: motor('Front Right drive', 5) })
    m = withSlot(m, 'pdp', 2, { breaker: { family: 'rev-ato', ratingA: 20 }, feeds: { kind: 'radio' } })
    return m
  }
  it('counts the motor slots that keep another breaker', () => {
    expect(slotsKeeping(placed(), REV40)).toBe(0)
    expect(slotsKeeping(placed(), { family: 'ctre-ato', ratingA: 40 })).toBe(2)
    expect(slotsKeeping(placed(), { family: 'rev-ato', ratingA: 30 })).toBe(2)
  })
  it('Apply to all sets every motor slot and leaves the radio\'s 20 A alone', () => {
    const next = { family: 'ctre-ato', ratingA: 30 }
    const m = applyToAll(placed(), next)
    expect(m.boards[0].slots.map((s) => s.breaker)).toEqual([next, next, { family: 'rev-ato', ratingA: 20 }])
    expect(slotsKeeping(m, next)).toBe(0)
  })
  it('an MPM\'s motor keeps its ATM breaker and is not counted as keeping', () => {
    let m = withSlot({ ...base(), usual: REV40 } as PowerMap, 'pdp', 0, { breaker: REV40, feeds: { kind: 'mpm' } })
    m = withSlot(m, 'mpm-1', 0, { breaker: { family: 'atm', ratingA: 10 }, feeds: motor('Climber', 30) })
    const next = applyToAll(m, { family: 'ctre-ato', ratingA: 30 })
    expect(next.boards[1].slots[0].breaker).toEqual({ family: 'atm', ratingA: 10 })
    expect(slotsKeeping(m, { family: 'rev-ato', ratingA: 40 })).toBe(0)
  })
})

describe('the strip', () => {
  it('unset: says so', () => {
    expect(stripText(null, MOTORS)).toEqual({ text: 'Breakers: not set: judged against the fastest legal 40 A breaker', unset: true })
    expect(stripText(base(), MOTORS).unset).toBe(true)
  })
  it('set: main, every motor, how many placed', () => {
    let m: PowerMap = { ...base(), main: 'bussmann', usual: REV40 }
    m = withSlot(m, 'pdp', 0, { breaker: REV40, feeds: motor('Front Left drive', 3) })
    expect(stripText(m, MOTORS)).toEqual({ text: 'Breakers: main Bussmann CB185/CB285-120 · every motor REV ATO 40 A · 1 of 3 motors placed', unset: false })
  })
  it('only one of the two chosen: the other says not set', () => {
    expect(stripText({ ...base(), usual: REV40 }, []).text).toBe('Breakers: main not set (Bussmann assumed) · every motor REV ATO 40 A')
  })
})

describe('the line a change writes', () => {
  it('is stamped by this device (seq one past its largest) with the given from', () => {
    const m = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: motor('a') })
    const first = mapLine([], m, { device: 'laptop-a', role: 'pit' }, new Date('2026-11-08T12:00:00Z'))
    expect(first).toMatchObject({ seq: 1, from: '2026-11-08T10:00:00.000Z', by: { device: 'laptop-a', role: 'pit' }, when: '2026-11-08T12:00:00.000Z' })
    const second = mapLine([first], m, { device: 'laptop-a', role: 'pit' }, new Date('2026-11-08T12:01:00Z'), '2026-11-08T11:00:00.000Z')
    expect(second).toMatchObject({ seq: 2, from: '2026-11-08T11:00:00.000Z' })
  })
})
