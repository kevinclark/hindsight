/**
 * The logic behind the power map screen (src/ui/PowerMap.svelte) and the Breakers strip, kept apart from Svelte so it is
 * unit-tested: the slot layout, editing a map (always a new map, never in place), the order the popover walks the empty
 * slots in, the problems listed under the drawing, and the strip's words. Nothing here reads a log or the history.
 * The record's shape and the lookups the rules use are in power-map.ts.
 */
import { breakerFamily } from './breakers.ts'
import { breakerForMotor, PDP_FAMILIES, type Feed, type MapBoard, type MapBreaker, type MapSlot, type PdpFamily, type PowerMap } from './power-map.ts'
import { boardStamp, type BoardRole, type HistoryEvent } from '../triage/history.ts'

// ---- The CTRE PDP 2.0, as drawn --------------------------------------------------------------------------------------

/**
 * The slot numbers in each row of the drawing, left to right, studs on the right: the top row counts 0 to 11 from the
 * + stud outward (so it reads 11…0 left to right), the bottom row 12 to 23 left to right. Read from CTRE's low-resolution
 * drawing (PDP 2.0 user guide, p. 9) and NOT yet checked against a real board: the screen says so. Change it here only.
 */
export const PDP_ROWS: readonly (readonly number[])[] = [
  [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
]
export const PDP_SLOTS = 24
export const MPM_SLOTS = 6
export const PDP_ID = 'pdp'

/** The rows as shown: a board mounted the other way is the same drawing turned 180° (rows swap and each reverses). */
export function slotRows(rotated: boolean): number[][] {
  const rows = PDP_ROWS.map((r) => [...r])
  return rotated ? rows.reverse().map((r) => r.reverse()) : rows
}

// ---- Breakers: names, colours -----------------------------------------------------------------------------------------

export const FAMILY_LABEL: Record<string, string> = { 'rev-ato': 'REV ATO', 'ctre-ato': 'CTRE ATO', 'snap-action': 'Snap Action', atm: 'ATM' }
export const MAIN_LABEL = { bussmann: 'Bussmann CB185/CB285-120', optifuse: 'Optifuse 153120/253120' } as const

/** The ratings offered for a family's chips: its datasheet's, up to 40 A on the PDP; an MPM's ATM breakers are 5 to 15 A. */
export function ratingsFor(family: string): number[] {
  if (family === 'atm') return [5, 10, 15]
  return (breakerFamily(family)?.ratingsA ?? [10, 20, 30, 40]).filter((a) => a <= 40)
}

/** ATO rating colours (SAE J1284): 5 tan, 10 red, 15 blue, 20 yellow, 25 natural, 30 green, 40 orange. Dark text goes on every one. */
const ATO: Record<number, { fill: string; name: string }> = {
  5: { fill: '#d9b98a', name: 'tan' }, 10: { fill: '#e8736c', name: 'red' }, 15: { fill: '#7fb2e5', name: 'blue' }, 20: { fill: '#f2d34e', name: 'yellow' },
  25: { fill: '#e9e4d4', name: 'natural' }, 30: { fill: '#79c488', name: 'green' }, 35: { fill: '#b7a6d9', name: 'violet' }, 40: { fill: '#f0a050', name: 'orange' },
}
export const breakerFill = (ratingA: number): string => ATO[ratingA]?.fill ?? '#d0d0d0'
export const breakerColourName = (ratingA: number): string => ATO[ratingA]?.name ?? 'grey'

export const breakerText = (b: MapBreaker): string => `${FAMILY_LABEL[b.family] ?? b.family} ${b.ratingA} A`

// ---- Feeds -------------------------------------------------------------------------------------------------------------

const SHORT: [RegExp, string][] = [[/^Front Left\b/, 'FL'], [/^Front Right\b/, 'FR'], [/^Back Left\b/, 'BL'], [/^Back Right\b/, 'BR']]
/** "Front Left drive" becomes "FL drive": a tile is narrow, the popover and the sentences use the full name. */
export const shortName = (name: string): string => SHORT.reduce((n, [re, to]) => n.replace(re, to), name)

/** What a slot feeds, in words, never a bare number: "FL drive · CAN 3", "Radio", "roboRIO", "MPM 1", "Vision". */
export function feedLabel(feed: Feed | null, short = false, mpmId?: string): string {
  if (!feed) return ''
  if (feed.kind === 'motor') return `${short ? shortName(feed.name) : feed.name}${feed.canId !== undefined ? ` · CAN ${feed.canId}` : ''}`
  if (feed.kind === 'radio') return 'Radio'
  if (feed.kind === 'roborio') return 'roboRIO'
  if (feed.kind === 'mpm') return mpmId ? `MPM ${mpmId.replace(/^mpm-/, '')}` : 'MPM'
  return feed.label || 'Other'
}

export interface ProfileMotor { name: string; canId?: number }

// ---- Reading a map -----------------------------------------------------------------------------------------------------

export const boardOf = (map: PowerMap, id: string): MapBoard | undefined => map.boards.find((b) => b.id === id)
export const slotOf = (map: PowerMap, boardId: string, slot: number): MapSlot | undefined => boardOf(map, boardId)?.slots.find((s) => s.slot === slot)
/** Every entry on a slot: one normally, more than one when the pit put two feeds on it (a problem, listed under the drawing). */
export const slotEntries = (map: PowerMap, boardId: string, slot: number): MapSlot[] => boardOf(map, boardId)?.slots.filter((s) => s.slot === slot) ?? []

/** The MPM hung off a PDP slot, if the slot feeds one. */
export const mpmAt = (map: PowerMap, pdpSlot: number): MapBoard | undefined =>
  map.boards.find((b) => b.kind === 'rev-mpm' && b.fedFrom?.board === PDP_ID && b.fedFrom.slot === pdpSlot)


/**
 * The slot the popover moves to after a choice: the next empty one in slot-number order after `after`, wrapping round;
 * null when every slot of the board is taken.
 */
export function nextEmptySlot(map: PowerMap, boardId: string, after: number): number | null {
  const board = boardOf(map, boardId)
  const count = board?.kind === 'rev-mpm' ? MPM_SLOTS : PDP_SLOTS
  for (let step = 1; step <= count; step++) {
    const slot = (after + step) % count
    if (!board?.slots.some((s) => s.slot === slot && (s.feeds !== null || s.breaker !== null))) return slot
  }
  return null
}

/** The profile's motors that no slot feeds (a motor is on a slot by CAN ID, else name: as the rules find it). */
export function unplacedMotors(map: PowerMap | null, motors: ProfileMotor[]): ProfileMotor[] {
  return motors.filter((m) => !breakerForMotor(map, m.name, m.canId).mapped)
}

/** Every motor slot (any board): the slots whose feed is a motor. */
const motorSlots = (map: PowerMap) => map.boards.flatMap((b) => b.slots.filter((s) => s.feeds?.kind === 'motor').map((s) => ({ board: b, slot: s })))

// ---- Problems ----------------------------------------------------------------------------------------------------------

export interface MapProblem {
  kind: 'two-motors' | 'motor-twice' | 'illegal-breaker' | 'unplaced'
  text: string
  /** The slots to light when the line is hovered (PDP slot numbers). */
  slots: number[]
}

/** The 2026 manual's words, with the rule number and the season. */
export const R621 = '2026 manual R621: "Each branch circuit must be protected by 1 and only 1 circuit breaker or fuse on the PD per Table 8-3. No other electrical load can be connected to the breaker or fuse supplying this circuit"'
export const R619 = '2026 manual R619: the only circuit breakers permitted in a PD are Snap Action VB3-A, AT2-A, MX5-A or MX5-L, REV ATO and CTRE ATO, all 40A or lower (and ATM breakers up to the fuse sizes R620 permits)'

/**
 * What doesn't add up, one sentence each: two motors on one slot, a breaker over 40 A on the PDP or one the maker doesn't
 * make (not on R619's list), and a single folded line for the motors no slot feeds. No input check on an MPM (a
 * REV MPM takes 40 A in total, so no legal PDP slot can overload it).
 */
export function mapProblems(map: PowerMap | null, motors: ProfileMotor[]): MapProblem[] {
  const out: MapProblem[] = []
  const pdp = map && boardOf(map, PDP_ID)
  if (map && pdp) {
    // Two motors on one slot: the record lists one entry per feed, so a slot named twice with motors is the problem.
    const onSlot = new Map<number, string[]>()
    const where = new Map<string, number[]>()
    for (const s of pdp.slots) {
      if (s.feeds?.kind !== 'motor') continue
      onSlot.set(s.slot, [...(onSlot.get(s.slot) ?? []), s.feeds.name])
      const key = s.feeds.canId !== undefined ? `can ${s.feeds.canId}` : s.feeds.name
      where.set(key, [...(where.get(key) ?? []), s.slot])
    }
    for (const [slot, names] of onSlot) {
      if (names.length > 1) out.push({ kind: 'two-motors', slots: [slot], text: `Slot ${slot} feeds ${names.length} motors (${names.join(', ')}). ${R621}.` })
    }
    for (const slots of where.values()) {
      const distinct = [...new Set(slots)]
      if (distinct.length > 1) out.push({ kind: 'motor-twice', slots: distinct, text: `${feedLabel(pdp.slots.find((s) => s.slot === distinct[0] && s.feeds?.kind === 'motor')!.feeds)} is on slots ${distinct.join(' and ')}: a motor controller has one breaker.` })
    }
    for (const s of pdp.slots) {
      const b = s.breaker
      if (!b) continue
      const listed = breakerFamily(b.family)?.ratingsA.includes(b.ratingA) ?? false
      if (b.ratingA > 40) out.push({ kind: 'illegal-breaker', slots: [s.slot], text: `Slot ${s.slot}: a ${b.ratingA} A breaker isn't legal on a PDP channel (40 A or lower). ${R619}.` })
      else if (!PDP_FAMILIES.includes(b.family as PdpFamily) || !listed) out.push({ kind: 'illegal-breaker', slots: [s.slot], text: `Slot ${s.slot}: ${breakerText(b)} isn't on the list of breakers a PDP may hold. ${R619}.` })
    }
  }
  const missing = unplacedMotors(map, motors)
  const any = map ? motorSlots(map).length > 0 : false
  if (missing.length && !any) out.push({ kind: 'unplaced', slots: [], text: 'Motors not placed yet: the warnings still work, they just won\'t name the slot.' })
  else if (missing.length) out.push({ kind: 'unplaced', slots: [], text: `${missing.length} not placed · next: ${missing[0].name}` })
  return out
}

/** "18 of 20 motors placed" (the strip). */
export const placedCount = (map: PowerMap | null, motors: ProfileMotor[]) => ({ placed: motors.length - unplacedMotors(map, motors).length, total: motors.length })

// ---- Editing a map -----------------------------------------------------------------------------------------------------

/** A map with nothing set yet (the first change to a robot starts from this). */
export function emptyMap(robot: string, from: string): PowerMap {
  return { type: 'power-map', v: 1, robot, from, main: null, usual: null, boards: [{ id: PDP_ID, kind: 'ctre-pdp-2', slots: [] }], by: { device: '', role: 'pit' }, seq: 0, when: '' }
}

const sorted = (slots: MapSlot[]) => [...slots].sort((a, b) => a.slot - b.slot)

/**
 * The map with one slot set (`content` null clears it). A slot that feeds an MPM brings an MPM board with it, joined to
 * that slot; moving the MPM off the slot takes the board with its slots. Returns a new map; `by`, `seq` and `when` are the writer's.
 */
export function withSlot(map: PowerMap, boardId: string, slot: number, content: { breaker: MapBreaker | null; feeds: Feed | null } | null): PowerMap {
  const had = slotOf(map, boardId, slot)
  let boards = map.boards.map((b) => {
    if (b.id !== boardId) return b
    const rest = b.slots.filter((s) => s.slot !== slot)
    return { ...b, slots: sorted(content && !(content.breaker === null && content.feeds === null) ? [...rest, { slot, ...content }] : rest) }
  })
  if (boardId === PDP_ID) {
    const wasMpm = had?.feeds?.kind === 'mpm'
    const isMpm = content?.feeds?.kind === 'mpm'
    if (wasMpm && !isMpm) boards = boards.filter((b) => !(b.kind === 'rev-mpm' && b.fedFrom?.board === PDP_ID && b.fedFrom.slot === slot))
    if (isMpm && !mpmAt({ ...map, boards }, slot)) {
      const n = 1 + Math.max(0, ...boards.filter((b) => b.kind === 'rev-mpm').map((b) => Number(b.id.replace(/^mpm-/, '')) || 0))
      boards = [...boards, { id: `mpm-${n}`, kind: 'rev-mpm', fedFrom: { board: PDP_ID, slot }, slots: [] }]
    }
  }
  return { ...map, boards }
}

/** A second feed on a slot that already has one (kept, and flagged under the drawing: R621 allows one motor controller per breaker). */
export function withExtraFeed(map: PowerMap, boardId: string, slot: number, content: { breaker: MapBreaker | null; feeds: Feed }): PowerMap {
  return { ...map, boards: map.boards.map((b) => (b.id === boardId ? { ...b, slots: sorted([...b.slots, { slot, ...content }]) } : b)) }
}

/** The motor slots whose breaker is not `usual`: what "N placed slots keep <old>" counts. */
export function slotsKeeping(map: PowerMap, usual: MapBreaker): number {
  return motorSlots(map).filter(({ slot }) => !slot.breaker || slot.breaker.family !== usual.family || slot.breaker.ratingA !== usual.ratingA).length
}

/** Every slot that feeds a motor takes `usual` as its breaker ("Apply to all"). Radio, roboRIO and other slots keep theirs. */
export function applyToAll(map: PowerMap, usual: MapBreaker): PowerMap {
  return { ...map, boards: map.boards.map((b) => ({ ...b, slots: b.slots.map((s) => (s.feeds?.kind === 'motor' ? { ...s, breaker: { family: b.kind === 'rev-mpm' ? s.breaker?.family ?? 'atm' : usual.family, ratingA: b.kind === 'rev-mpm' ? s.breaker?.ratingA ?? usual.ratingA : usual.ratingA } } : s)) })) }
}

/**
 * The history line for a changed map: the writer's stamp (`boardStamp`, so two tabs can't repeat a seq), `from` (when the
 * breakers took effect, not when written) and who wrote it. `from` is kept from `map` unless given.
 */
export function mapLine(history: HistoryEvent[], map: PowerMap, who: { device: string; role: BoardRole }, now: Date, from?: string): PowerMap {
  return { ...map, from: from ?? map.from, by: { device: who.device, role: who.role }, ...boardStamp(history, who.device, now) }
}

// ---- The strip ---------------------------------------------------------------------------------------------------------

/** The Breakers strip's one line, and whether the two choices are unset (then the line says so and the button says Set). */
export function stripText(map: PowerMap | null, motors: ProfileMotor[]): { text: string; unset: boolean } {
  const unset = !map || (map.main === null && map.usual === null)
  if (unset) return { text: 'Breakers: not set: judged against the fastest legal 40 A breaker', unset }
  const main = map!.main ? `main ${MAIN_LABEL[map!.main]}` : 'main not set (Bussmann assumed)'
  const usual = map!.usual ? `every motor ${breakerText(map!.usual)}` : 'every motor not set'
  const { placed, total } = placedCount(map, motors)
  return { text: `Breakers: ${main} · ${usual}${total ? ` · ${placed} of ${total} motors placed` : ''}`, unset }
}
