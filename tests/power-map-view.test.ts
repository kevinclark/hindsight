// The power map screen's logic (src/power/power-map-view.ts): layout, editing, the popover's walk, problems, the strip's words.
import { describe, expect, it } from 'vitest'
import { applyToAll, emptyMap, feedLabel, feedParts, isMapBlank, judgedAgainst, readRotated, robotSeenLast, savedLine, writeRotated, mapLine, onlyFromNow, planFromFinding, stampAll, mapProblems, mpmAt, nextEmptySlot, PDP_ROWS, placedCount, shortName, slotEntries, slotRows, slotsKeeping, stripText, unplacedMotors, withExtraFeed, withSlot } from '../src/power/power-map-view.ts'
import { breakerForMotor, powerMapAt, type Feed, type PowerMap } from '../src/power/power-map.ts'

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
  it('an MPM\'s ATM breaker of 5 to 15 A is fine, and there is no check of its input', () => {
    let m = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: { kind: 'mpm' } })
    for (const a of [5, 10, 15]) m = withSlot(m, 'mpm-1', a / 5, { breaker: { family: 'atm', ratingA: a }, feeds: motor(`Climber ${a}`, 30 + a) })
    expect(mapProblems(m, [{ name: 'Climber 5', canId: 35 }, { name: 'Climber 10', canId: 40 }, { name: 'Climber 15', canId: 45 }])).toEqual([])
  })
  it('two motors on one MPM slot are flagged like the PDP\'s, naming the MPM', () => {
    let m = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: { kind: 'mpm' } })
    m = withSlot(m, 'mpm-1', 2, { breaker: { family: 'atm', ratingA: 10 }, feeds: motor('Climber', 30) })
    m = withExtraFeed(m, 'mpm-1', 2, { breaker: { family: 'atm', ratingA: 10 }, feeds: motor('Winch', 31) })
    const two = mapProblems(m, [{ name: 'Climber', canId: 30 }, { name: 'Winch', canId: 31 }]).find((x) => x.kind === 'two-motors')!
    expect(two.text).toContain('MPM 1 slot 2 feeds 2 motors (Climber, Winch)')
    expect(two.text).toContain('R621')
    expect(two.board).toBe('mpm-1')
  })
  it('an ATM breaker outside 5 to 15 A on an MPM is flagged', () => {
    let m = withSlot(base(), 'pdp', 0, { breaker: REV40, feeds: { kind: 'mpm' } })
    m = withSlot(m, 'mpm-1', 1, { breaker: { family: 'atm', ratingA: 20 }, feeds: motor('Climber', 30) })
    m = withSlot(m, 'mpm-1', 2, { breaker: { family: 'atm', ratingA: 3 }, feeds: { kind: 'other' } })
    const bad = mapProblems(m, [{ name: 'Climber', canId: 30 }]).filter((x) => x.kind === 'illegal-breaker')
    expect(bad).toHaveLength(2)
    expect(bad[0].text).toMatch(/^MPM 1 slot 1: a 20 A breaker is outside/)
    expect(bad[1].text).toMatch(/^MPM 1 slot 2: a 3 A breaker is outside/)
    expect(bad[0].text).toContain('5 to 15 A')
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
    expect(stripText(null, MOTORS)).toEqual({ text: 'Breakers: not set: judged against the first legal 40 A breaker to trip', unset: true })
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

describe('[PM-12] a change made from a finding reaches every later map of the robot', () => {
  const ROBOT = 'Test robot @ main'
  const stamp = (m: PowerMap, over: Partial<PowerMap> = {}): PowerMap => ({ ...m, by: { device: 'laptop-a', role: 'pit' }, seq: 1, when: '2026-11-01T00:00:00.000Z', ...over })
  const early = stamp(withSlot({ ...emptyMap(ROBOT, '2026-11-01T09:00:00.000Z'), usual: REV40 } as PowerMap, 'pdp', 1, { breaker: REV40, feeds: motor('Intake', 13) }))
  const later = stamp(withSlot({ ...early, from: '2026-11-05T16:00:00.000Z', main: 'optifuse' }, 'pdp', 2, { breaker: REV40, feeds: motor('Hood', 14) }), { seq: 2 })
  const later2 = stamp({ ...later, from: '2026-11-07T10:00:00.000Z' }, { seq: 3 })
  const at = (h: PowerMap[], iso: string) => powerMapAt(h, ROBOT, iso)
  const slotBreaker = (m: PowerMap | null, slot: number) => m?.boards[0].slots.find((s) => s.slot === slot)?.breaker
  const who = { device: 'laptop-a', role: 'pit' as const }
  const NOW = new Date('2026-11-08T12:00:00Z')
  const write = (history: PowerMap[], maps: PowerMap[]) => [...history, ...stampAll(history, maps, who, NOW)]
  // The match the finding came from was played 2026-11-03: the early map is in effect, a Tools edit followed on the 5th and 7th.
  const FROM = '2026-11-03T12:00:00.000Z'
  const edit = (m: PowerMap) => withSlot(m, 'pdp', 1, { breaker: { family: 'rev-ato', ratingA: 20 }, feeds: motor('Intake', 13) })

  it('writes the change from the match start and again on every later line, from that line\'s own time', () => {
    const history = [early, later, later2]
    const plan = planFromFinding(history, ROBOT, FROM, early, edit(early))
    expect(plan.forward.map((m) => m.from)).toEqual([FROM, later.from, later2.from])
    expect(plan.laterDates).toEqual([later.from, later2.from])
    const after = write(history, plan.forward)
    expect(slotBreaker(at(after, FROM), 1)).toEqual({ family: 'rev-ato', ratingA: 20 })
    expect(slotBreaker(at(after, '2026-11-06T00:00:00.000Z'), 1)).toEqual({ family: 'rev-ato', ratingA: 20 })
    expect(slotBreaker(at(after, '2026-11-08T00:00:00.000Z'), 1)).toEqual({ family: 'rev-ato', ratingA: 20 })
  })
  it('keeps everything else on the later lines (their main breaker, their other slots)', () => {
    const history = [early, later, later2]
    const after = write(history, planFromFinding(history, ROBOT, FROM, early, edit(early)).forward)
    const now = at(after, '2026-11-06T00:00:00.000Z')!
    expect(now.main).toBe('optifuse')
    expect(slotBreaker(now, 2)).toEqual(REV40)
    expect(at(after, FROM)!.main).toBeNull()
    expect(slotBreaker(at(after, FROM), 2)).toBeUndefined()
  })
  it('with no later line it is one line and says nothing about later dates', () => {
    const plan = planFromFinding([early], ROBOT, FROM, early, edit(early))
    expect(plan.forward).toHaveLength(1)
    expect(plan.laterDates).toEqual([])
  })
  it('a change to the main or the usual breaker, and a new MPM, reach later lines too', () => {
    const history = [early, later]
    const next = withSlot({ ...early, main: 'bussmann', usual: { family: 'ctre-ato', ratingA: 30 } } as PowerMap, 'pdp', 5, { breaker: REV40, feeds: { kind: 'mpm' } })
    const after = write(history, planFromFinding(history, ROBOT, FROM, early, next).forward)
    const l = at(after, '2026-11-06T00:00:00.000Z')!
    expect(l.main).toBe('bussmann')
    expect(l.usual).toEqual({ family: 'ctre-ato', ratingA: 30 })
    expect(l.boards.map((b) => b.id)).toEqual(['pdp', 'mpm-1'])
    expect(l.boards[1].fedFrom).toEqual({ board: 'pdp', slot: 5 })
    expect(slotBreaker(l, 2)).toEqual(REV40) // its own slot 2 stays
  })
  it('a robot with no map before the match: the later lines still get the change', () => {
    const history = [later]
    const plan = planFromFinding(history, ROBOT, FROM, null, withSlot(emptyMap(ROBOT, FROM), 'pdp', 7, { breaker: REV40, feeds: motor('Roller', 9) }))
    const after = write(history, plan.forward)
    expect(slotBreaker(at(after, FROM), 7)).toEqual(REV40)
    expect(slotBreaker(at(after, '2026-11-06T00:00:00.000Z'), 7)).toEqual(REV40)
    expect(slotBreaker(at(after, '2026-11-06T00:00:00.000Z'), 2)).toEqual(REV40)
  })
  it('Undo puts every line back as it was, from the same times', () => {
    const history = [early, later, later2]
    const plan = planFromFinding(history, ROBOT, FROM, early, edit(early))
    const done = write(history, plan.forward)
    const undone = write(done, plan.undo)
    for (const iso of [FROM, '2026-11-06T00:00:00.000Z', '2026-11-08T00:00:00.000Z']) {
      expect(JSON.stringify(at(undone, iso)!.boards)).toBe(JSON.stringify(at(history, iso)!.boards))
      expect(at(undone, iso)!.main).toBe(at(history, iso)!.main)
    }
  })
  it('Undo of a first map goes back to a map with nothing in it', () => {
    const next = withSlot(emptyMap(ROBOT, FROM), 'pdp', 7, { breaker: REV40, feeds: motor('Roller', 9) })
    const plan = planFromFinding([], ROBOT, FROM, null, next)
    const undone = write(write([], plan.forward), plan.undo)
    expect(isMapBlank(at(undone, FROM))).toBe(true)
  })
  it('"Only from now" leaves the match start and the lines between as they were, and the change starts now', () => {
    const history = [early, later, later2]
    const plan = planFromFinding(history, ROBOT, FROM, early, edit(early))
    const nowIso = NOW.toISOString()
    const after = write(write(history, plan.forward), onlyFromNow(plan, edit(later2), nowIso))
    expect(slotBreaker(at(after, FROM), 1)).toEqual(REV40)
    expect(slotBreaker(at(after, '2026-11-06T00:00:00.000Z'), 1)).toEqual(REV40)
    expect(slotBreaker(at(after, '2026-11-08T00:00:00.000Z'), 1)).toEqual(REV40) // before now
    expect(slotBreaker(at(after, '2026-11-08T13:00:00.000Z'), 1)).toEqual({ family: 'rev-ato', ratingA: 20 })
  })
})

describe('the finding\'s "judged against" line', () => {
  const when = (m: PowerMap) => ({ ...m, when: '2026-11-08T12:00:00.000Z' })
  const placed = when(withSlot({ ...base(), usual: REV40 } as PowerMap, 'pdp', 7, { breaker: REV40, feeds: motor('Intake right', 16) }))
  it('names the breaker, the slot and when it was set', () => {
    const t = judgedAgainst({ breaker: 'REV 40 A (set on its slot in the power map)', slot: 'PDP slot 7' }, placed)
    expect(t).toMatch(/^REV 40 A in PDP slot 7 \(set Nov \d+\)$/)
  })
  it('says not set when the finding\'s breaker was not set, whatever map is in effect', () => {
    expect(judgedAgainst({ breaker: 'CTRE 40 A (not set: the first legal 40 A breaker to trip here)', slot: 'not mapped' }, placed)).toBe('CTRE 40 A, slot not mapped (not set)')
  })
  it('never says set for a map with nothing in it (a first map that was undone), or no map', () => {
    expect(isMapBlank(when(base()))).toBe(true)
    expect(judgedAgainst({ breaker: 'REV 40 A (the power map\'s usual breaker)', slot: 'not mapped' }, when(base()))).toBe('REV 40 A, slot not mapped (not set)')
    expect(judgedAgainst({ breaker: 'REV 40 A (the power map\'s usual breaker)', slot: 'not mapped' }, null)).toBe('REV 40 A, slot not mapped (not set)')
  })
  it('a usual breaker with no slot is set (the map has something in it)', () => {
    expect(judgedAgainst({ breaker: 'REV 40 A (the power map\'s usual breaker)', slot: 'not mapped' }, placed)).toMatch(/^REV 40 A, slot not mapped \(set Nov \d+\)$/)
  })
})

describe('the robot a strip names when Foresight is not connected', () => {
  const m = (profileId: string, playedAt: number | null, how = 'signals') => ({ robot: { profileId, how }, playedAt })
  it('is the robot of the newest log, ignoring undated ones', () => {
    expect(robotSeenLast([m('A', 100), m('B', 300), m('C', 200), m('D', null)])).toBe('B')
  })
  it('is null with no log', () => {
    expect(robotSeenLast([])).toBeNull()
    expect(robotSeenLast([m('D', null)])).toBeNull()
  })
})

describe('the remembered 180° rotation, per robot', () => {
  const fake = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }
  it('is off until set, remembered per robot, and read the same by the map and the thumbnail', () => {
    const s = fake()
    expect(readRotated(s, 'A')).toBe(false)
    writeRotated(s, 'A', true)
    expect(readRotated(s, 'A')).toBe(true)
    expect(readRotated(s, 'B')).toBe(false)
    writeRotated(s, 'A', false)
    expect(readRotated(s, 'A')).toBe(false)
  })
  it('a storage that throws reads as not rotated', () => {
    const bad = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
    expect(readRotated(bad, 'A')).toBe(false)
    expect(() => writeRotated(bad, 'A', true)).not.toThrow()
  })
})

describe('a tile\'s label: the name may be cut, the CAN ID is always its own line', () => {
  it('splits a motor into its short name and its CAN ID', () => {
    expect(feedParts(motor('Front Left drive', 3), true)).toEqual({ name: 'FL drive', can: 'CAN 3' })
    expect(feedParts(motor('Hood'), true)).toEqual({ name: 'Hood' })
    expect(feedParts(motor('Back Right steer', 0), true)).toEqual({ name: 'BR steer', can: 'CAN 0' })
  })
  it('radio, roboRIO, MPM and other have no CAN line', () => {
    expect(feedParts({ kind: 'radio' }, true)).toEqual({ name: 'Radio' })
    expect(feedParts({ kind: 'mpm' }, true, 'mpm-1')).toEqual({ name: 'MPM 1' })
    expect(feedParts(null, true)).toEqual({ name: '' })
  })
  it('a long name keeps its CAN ID whole (the name is the only part a tile may clip)', () => {
    const p = feedParts(motor('Flywheel follower 16 with a very long name', 16), true)
    expect(p.can).toBe('CAN 16')
  })
})

describe('the line under the map: who saved it, and how many slots are set', () => {
  const m = (): PowerMap => ({ ...withSlot(withSlot(base(), 'pdp', 1, { breaker: REV40, feeds: motor('A', 1) }), 'pdp', 2, { breaker: null, feeds: { kind: 'radio' } }), by: { device: 'f3a9c2d41b7e0055', role: 'pit' }, seq: 4, when: '2026-11-08T12:00:00.000Z' })
  it('names the role, the laptop (shortened), the slots set and when it took effect', () => {
    const t = savedLine(m())
    expect(t).toMatch(/^Saved Nov \d+ by pit on laptop f3a9c2d4 · 2 slots set · in effect from Nov \d+$/)
  })
  it('counts slots, once each, counting a breaker alone or a feed alone', () => {
    let x = m()
    x = withExtraFeed(x, 'pdp', 1, { breaker: REV40, feeds: motor('B', 2) })
    expect(savedLine(x)).toContain('2 slots set')
    expect(savedLine(withSlot(x, 'pdp', 9, { breaker: REV40, feeds: null }))).toContain('3 slots set')
  })
  it('says one slot, and no slots, in the singular and plain', () => {
    expect(savedLine(withSlot(m(), 'pdp', 2, null))).toContain('1 slot set')
    expect(savedLine({ ...base(), by: { device: 'd', role: 'drive' }, seq: 1, when: '2026-11-08T12:00:00.000Z' })).toContain('no slots set')
  })
})
