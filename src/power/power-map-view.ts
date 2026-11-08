/**
 * The logic behind the power map screen (src/ui/PowerMap.svelte) and the Breakers strip, kept apart from Svelte so it is
 * unit-tested: the slot layout, editing a map (always a new map, never in place), the order the popover walks the empty
 * slots in, the problems listed under the drawing, and the strip's words. Nothing here reads a log or the history.
 * The record's shape and the lookups the rules use are in power-map.ts.
 */
import { breakerFamily } from './breakers.ts'
import { robotKey } from '../profiles/index.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { breakerForMotor, FASTEST_LEGAL, feedsMotor, powerMapAt, PDP_FAMILIES, type BreakerDefault, type BreakerSource, type Feed, type MapException, type MapBoard, type MapBreaker, type MapSlot, type PdpFamily, type PowerMap } from './power-map.ts'
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

/** A slot's label in two parts for a tile: the name (a tile may cut it short) and, for a motor with a CAN ID, "CAN n" (never cut). */
export function feedParts(feed: Feed | null, short = false, mpmId?: string): { name: string; can?: string } {
  if (feed?.kind === 'motor') return { name: short ? shortName(feed.name) : feed.name, ...(feed.canId !== undefined ? { can: `CAN ${feed.canId}` } : {}) }
  return { name: feedLabel(feed, short, mpmId) }
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
  kind: 'two-motors' | 'motor-twice' | 'illegal-breaker' | 'exception-shadowed' | 'unplaced'
  text: string
  /** The slots to light when the line is hovered (PDP slot numbers). */
  slots: number[]
  /** An MPM's id when the problem is on an MPM slot (then `slots` are that MPM's slots). */
  board?: string
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
  // Exceptions: a breaker over 40 A or one the maker doesn't make, and one beside a slot that says otherwise (the slot wins).
  for (const x of map?.exceptions ?? []) {
    const who = `${x.name}${x.canId !== undefined ? ` (CAN ${x.canId})` : ''}`
    const listed = breakerFamily(x.breaker.family)?.ratingsA.includes(x.breaker.ratingA) ?? false
    if (x.breaker.ratingA > 40) out.push({ kind: 'illegal-breaker', slots: [], text: `${who}: a ${x.breaker.ratingA} A breaker isn't legal on a PDP channel (40 A or lower). ${R619}.` })
    else if (!listed) out.push({ kind: 'illegal-breaker', slots: [], text: `${who}: ${breakerText(x.breaker)} isn't on the list of breakers a PDP may hold. ${R619}.` })
    const on = map ? motorSlots(map).find(({ slot }) => slot.feeds?.kind === 'motor' && feedsMotor(slot.feeds, x.name, x.canId)) : undefined
    const sb = on?.slot.breaker
    if (on && sb && (sb.family !== x.breaker.family || sb.ratingA !== x.breaker.ratingA)) {
      const where = on.board.id === PDP_ID ? 'PDP' : `MPM ${on.board.id.replace(/^mpm-/, '')}`
      out.push({ kind: 'exception-shadowed', slots: on.board.id === PDP_ID ? [on.slot.slot] : [], ...(on.board.id === PDP_ID ? {} : { board: on.board.id }), text: `${who} has a ${x.breaker.ratingA} A exception and sits on ${where} slot ${on.slot.slot} with ${breakerText(sb)}: the slot wins.` })
    }
  }
  // An MPM's slots: one motor per slot (R621 applies to any branch circuit), and an ATM breaker of 5 to 15 A.
  for (const mpm of map?.boards.filter((b) => b.kind === 'rev-mpm') ?? []) {
    const name = `MPM ${mpm.id.replace(/^mpm-/, '')}`
    const onMpm = new Map<number, string[]>()
    for (const s of mpm.slots) if (s.feeds?.kind === 'motor') onMpm.set(s.slot, [...(onMpm.get(s.slot) ?? []), s.feeds.name])
    for (const [slot, names] of onMpm) {
      if (names.length > 1) out.push({ kind: 'two-motors', board: mpm.id, slots: [slot], text: `${name} slot ${slot} feeds ${names.length} motors (${names.join(', ')}). ${R621}.` })
    }
    for (const s of mpm.slots) {
      if (s.breaker && (s.breaker.ratingA < 5 || s.breaker.ratingA > 15)) out.push({ kind: 'illegal-breaker', board: mpm.id, slots: [s.slot], text: `${name} slot ${s.slot}: a ${s.breaker.ratingA} A breaker is outside the 5 to 15 A an MPM channel takes.` })
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

/** The PDP's motor slots whose breaker is not `usual`: what "N placed slots keep <old>" counts (an MPM's ATM breakers are its own). */
export function slotsKeeping(map: PowerMap, usual: MapBreaker): number {
  return motorSlots(map).filter(({ board }) => board.id === PDP_ID).filter(({ slot }) => !slot.breaker || slot.breaker.family !== usual.family || slot.breaker.ratingA !== usual.ratingA).length
}

/** Every slot that feeds a motor takes `usual` as its breaker, and the exceptions are cleared ("Apply to all"). Radio, roboRIO and other slots keep theirs. */
export function applyToAll(map: PowerMap, usual: MapBreaker): PowerMap {
  const { exceptions: _cleared, ...rest } = map
  return { ...rest, boards: map.boards.map((b) => ({ ...b, slots: b.slots.map((s) => (s.feeds?.kind === 'motor' ? { ...s, breaker: { family: b.kind === 'rev-mpm' ? s.breaker?.family ?? 'atm' : usual.family, ratingA: b.kind === 'rev-mpm' ? s.breaker?.ratingA ?? usual.ratingA : usual.ratingA } } : s)) })) }
}

/**
 * The history line for a changed map: the writer's stamp (`boardStamp`, so two tabs can't repeat a seq), `from` (when the
 * breakers took effect, not when written) and who wrote it. `from` is kept from `map` unless given.
 */
export function mapLine(history: HistoryEvent[], map: PowerMap, who: { device: string; role: BoardRole }, now: Date, from?: string): PowerMap {
  return { ...map, from: from ?? map.from, by: { device: who.device, role: who.role }, ...boardStamp(history, who.device, now) }
}

// ---- The strip ---------------------------------------------------------------------------------------------------------

/** The words the strip and the map put after a breaker that is the robot's default rather than a choice. */
export const DEFAULT_WORDS = "(Hindsight's default for this robot; change it in the map)"

/**
 * The Breakers strip's one line, and whether nothing at all is set (no map choice and no robot default: then the line says so
 * and the button reads Set). A robot's default is shown as such, so it is never a hidden setting.
 */
export function stripText(map: PowerMap | null, motors: ProfileMotor[], fallback?: BreakerDefault | null): { text: string; unset: boolean } {
  const unset = !map?.main && !map?.usual && !fallback
  if (unset) return { text: 'Breakers: not set: judged against the first legal 40 A breaker to trip', unset }
  const mainDefault = !map?.main && !!fallback
  const usualDefault = !map?.usual && !!fallback
  const main = map?.main ? `main ${MAIN_LABEL[map.main]}` : fallback ? `main ${MAIN_LABEL[fallback.main]}` : 'main not set (Bussmann assumed)'
  const usualB = map?.usual ?? fallback?.usual ?? null
  const usual = usualB ? `every motor ${breakerText(usualB)}` : 'every motor not set'
  const note = (d: boolean) => (d ? ` ${DEFAULT_WORDS}` : '')
  const rows = motorRows(map, motors, fallback)
  const exceptions = countExceptions(map, motors, fallback)
  const parts = [`${main}${note(mainDefault && !usualDefault)}`, `${usual}${note(usualDefault)}`]
  if (exceptions) parts.push(`${exceptions} exception${exceptions === 1 ? '' : 's'}`)
  const { placed, total } = placedCount(map, motors)
  if (map && total) parts.push(`${placed} of ${total} motors placed`)
  return { text: `Breakers: ${parts.join(' · ')}`, unset }
}

// ---- The Motors list: a motor's breaker without a slot ----------------------------------------------------------------------

export interface MotorRow {
  name: string
  canId?: number
  breaker: { family: string; ratingA: number }
  source: BreakerSource
  /** "PDP slot 6", "MPM 1 slot 2" or "no slot". */
  slotText: string
  /** On a breaker other than the usual one (an exception, or a slot that says otherwise). */
  exception: boolean
}

/** Every profile motor with the breaker it is judged by: exceptions first, then by CAN ID. */
export function motorRows(map: PowerMap | null, motors: ProfileMotor[], fallback?: BreakerDefault | null): MotorRow[] {
  const usual = map?.usual ?? fallback?.usual ?? null
  const rows = motors.map((m): MotorRow => {
    const b = breakerForMotor(map, m.name, m.canId, fallback)
    const differs = !!usual && (b.family !== usual.family || b.ratingA !== usual.ratingA)
    return {
      name: m.name, ...(m.canId !== undefined ? { canId: m.canId } : {}), breaker: { family: b.family, ratingA: b.ratingA }, source: b.source,
      slotText: b.slot !== undefined ? (b.board === PDP_ID ? `PDP slot ${b.slot}` : `MPM ${b.board?.replace(/^mpm-/, '')} slot ${b.slot}`) : 'no slot',
      exception: b.source === 'exception' || (b.source === 'slot' && differs),
    }
  })
  return rows.sort((a, b) => Number(b.exception) - Number(a.exception) || (a.canId ?? Infinity) - (b.canId ?? Infinity))
}

/** How many motors are on a breaker other than the usual one (an exception, or a slot that says otherwise): the one count the keeping line, the Motors summary and the strip all give. */
export const countExceptions = (map: PowerMap | null, motors: ProfileMotor[], fallback?: BreakerDefault | null): number => motorRows(map, motors, fallback).filter((r) => r.exception).length

/** "16 motors on REV ATO 40 A · 2 exceptions". */
export function motorsSummary(rows: MotorRow[], usual: MapBreaker | null): string {
  const n = rows.filter((r) => !r.exception).length
  const k = rows.length - n
  const on = usual ? `on ${breakerText(usual)}` : 'with no breaker set'
  return `${n} motor${n === 1 ? '' : 's'} ${on} · ${k === 0 ? 'no exceptions' : `${k} exception${k === 1 ? '' : 's'}`}`
}

const exceptionKey = (x: { name: string; canId?: number }) => (x.canId !== undefined ? `can ${x.canId}` : x.name)
const sameException = (x: MapException, m: ProfileMotor) => (x.canId !== undefined && m.canId !== undefined ? x.canId === m.canId : x.name === m.name)

/**
 * A motor's breaker changed from the Motors list. A motor on a slot changes the slot's breaker (one truth per motor); any other
 * motor gets an exception, or loses it when the breaker chosen is the usual one. Returns a new map.
 */
export function setMotorBreaker(map: PowerMap, motor: ProfileMotor, breaker: MapBreaker, usual: MapBreaker | null): PowerMap {
  for (const board of map.boards) {
    const entry = board.slots.find((s) => s.feeds?.kind === 'motor' && feedsMotor(s.feeds, motor.name, motor.canId))
    if (entry) {
      // One truth per motor: the slot's breaker is now the answer, so any exception for this motor goes.
      const { exceptions: old, ...bare } = map
      const kept = (old ?? []).filter((x) => !sameException(x, motor))
      return { ...bare, ...(kept.length ? { exceptions: kept } : {}), boards: map.boards.map((b) => (b === board ? { ...b, slots: b.slots.map((s) => (s === entry ? { ...s, breaker } : s)) } : b)) }
    }
  }
  const rest = (map.exceptions ?? []).filter((x) => !sameException(x, motor))
  const isUsual = !!usual && usual.family === breaker.family && usual.ratingA === breaker.ratingA
  const next = isUsual ? rest : [...rest, { name: motor.name, ...(motor.canId !== undefined ? { canId: motor.canId } : {}), breaker: { family: breaker.family as PdpFamily, ratingA: breaker.ratingA } }]
  const { exceptions: _old, ...without } = map
  return next.length ? { ...without, exceptions: next } : without
}

/**
 * One profile per robot: its main-branch one, else the first (the map belongs to the robot, not its branch). The Motors list shows
 * that profile's motors: a motor only another branch's profile has isn't listed (no 8033 profile has one).
 */
export function oneProfilePerRobot(profiles: RobotProfile[]): RobotProfile[] {
  const byKey = new Map<string, RobotProfile>()
  for (const p of profiles) {
    const k = robotKey(p)
    const have = byKey.get(k)
    if (!have || (have.code.branch !== 'main' && p.code.branch === 'main')) byKey.set(k, p)
  }
  return [...byKey.values()]
}

// ---- A change made from a finding ---------------------------------------------------------------------------------------

/** True for a map with nothing in it: no main, no usual, no slot with a breaker or a feed (a first map that was undone). */
export const isMapBlank = (map: PowerMap | null): boolean =>
  !map || (map.main === null && map.usual === null && map.boards.every((b) => b.slots.every((s) => s.breaker === null && s.feeds === null)))

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const entriesOf = (b: MapBoard | undefined, slot: number) => (b?.slots ?? []).filter((s) => s.slot === slot)

/**
 * `target` with the change from `before` to `next` applied: the main and usual breaker if they changed, every slot whose
 * entries differ (on a board `target` lacks, the board comes with it), and a board `next` no longer has taken away.
 * Everything else on `target` is left as it is.
 */
function applyChange(target: PowerMap, before: PowerMap, next: PowerMap): PowerMap {
  let out: PowerMap = { ...target, boards: target.boards.map((b) => ({ ...b, slots: [...b.slots] })) }
  if (!same(before.main, next.main)) out = { ...out, main: next.main }
  if (!same(before.usual, next.usual)) out = { ...out, usual: next.usual }
  const key = exceptionKey
  const was = new Map((before.exceptions ?? []).map((x) => [key(x), x]))
  const now = new Map((next.exceptions ?? []).map((x) => [key(x), x]))
  if (was.size || now.size) {
    let ex = [...(out.exceptions ?? [])]
    for (const [k, x] of was) if (!now.has(k)) ex = ex.filter((y) => key(y) !== k)
    for (const [k, x] of now) if (!same(was.get(k), x)) ex = [...ex.filter((y) => key(y) !== k), x]
    const { exceptions: _e, ...bare } = out
    out = ex.length ? { ...bare, exceptions: ex } : bare
  }
  for (const board of before.boards) if (!next.boards.some((b) => b.id === board.id)) out = { ...out, boards: out.boards.filter((b) => b.id !== board.id) }
  for (const board of next.boards) {
    const was = before.boards.find((b) => b.id === board.id)
    if (!out.boards.some((b) => b.id === board.id)) out = { ...out, boards: [...out.boards, { ...board, slots: [] }] }
    const numbers = new Set([...board.slots.map((s) => s.slot), ...(was?.slots ?? []).map((s) => s.slot)])
    for (const n of numbers) {
      if (same(entriesOf(was, n), entriesOf(board, n))) continue
      out = { ...out, boards: out.boards.map((b) => (b.id === board.id ? { ...b, slots: sorted([...b.slots.filter((s) => s.slot !== n), ...entriesOf(board, n)]) } : b)) }
    }
  }
  return out
}

export interface FindingPlan {
  /** The maps to write, each with its own `from`: the match start first, then every later line of the robot with the change applied. */
  forward: PowerMap[]
  /** The maps that put everything back as it was (the same `from` times). A first map goes back to a map with nothing in it. */
  undo: PowerMap[]
  /** The `from` of each later line the change was also applied to. */
  laterDates: string[]
}

/**
 * A change made from a finding applies from that match onward: the changed map is written from the match's start, and
 * every later line of that robot (each distinct later `from`) is written again with the same change applied, so a later edit
 * in Tools doesn't hide it. `before` is the map in effect at the match (null: none), `next` the map after the edit.
 */
export function planFromFinding(history: HistoryEvent[], robotIds: string | readonly string[], from: string, before: PowerMap | null, next: PowerMap): FindingPlan {
  const ids = typeof robotIds === 'string' ? [robotIds] : robotIds
  const robot = ids[0] // maps are written under the robot's key; lines under its old id are read too
  const was = before ?? emptyMap(robot, from)
  const laterFroms = [...new Set(history.filter((e): e is PowerMap => e.type === 'power-map' && ids.includes(e.robot) && Date.parse(e.from) > Date.parse(from)).map((e) => e.from))]
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  const lines = laterFroms.map((f) => ({ ...powerMapAt(history, ids, f)!, robot }))
  return {
    forward: [{ ...next, robot, from }, ...lines.map((l) => ({ ...applyChange(l, was, next), from: l.from }))],
    undo: [{ ...was, robot, from }, ...lines],
    laterDates: laterFroms,
  }
}

/** "Only from now": the change as it was before the finding's own match start and the lines between, then the changed map from `nowIso` (built on the latest line). */
export function onlyFromNow(plan: FindingPlan, latest: PowerMap, nowIso: string): PowerMap[] {
  return [...plan.undo, { ...latest, from: nowIso }]
}

/** The plan's maps as history lines: each keeps its own `from`; stamped one after another so each beats the one before at a tie. */
export function stampAll(history: HistoryEvent[], maps: PowerMap[], who: { device: string; role: BoardRole }, now: Date): PowerMap[] {
  const made: PowerMap[] = []
  for (const m of maps) made.push(mapLine([...history, ...made], m, who, now))
  return made
}

/**
 * A breaker finding's "judged against" line: its breaker and slot (from the finding's evidence) and when the map was set. "Not set"
 * when the finding says its breaker was not set, and for a map with nothing in it, never "set <date>" for those.
 */
export function judgedAgainst(evidence: { breaker?: unknown; slot?: unknown }, map: PowerMap | null): string {
  const breaker = String(evidence.breaker ?? '').split(' (')[0]
  const slot = String(evidence.slot ?? '')
  const text = String(evidence.breaker ?? '')
  if (/\(this robot's default\)/.test(text)) return `${breaker}${slot === 'not mapped' ? ', slot not mapped' : ` in ${slot}`} (this robot's default)`
  const unset = /\(not set/.test(text) || isMapBlank(map)
  const set = unset ? 'not set' : `set ${new Date(map!.when).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  return `${breaker}${slot === 'not mapped' ? ', slot not mapped' : ` in ${slot}`} (${set})`
}

/** The profile id of the newest dated log among these summaries (the robot most recently seen in the library), or null. */
export function robotSeenLast(summaries: { robot: { profileId: string }; playedAt: number | null }[]): string | null {
  let best: { profileId: string; playedAt: number } | null = null
  for (const s of summaries) if (s.playedAt !== null && (!best || s.playedAt > best.playedAt)) best = { profileId: s.robot.profileId, playedAt: s.playedAt }
  return best?.profileId ?? null
}

// ---- The remembered rotation (the map and the finding's thumbnail read it the same way) -------------------------------------
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void }
const ROTATED = (robot: string) => `hindsight.powermap.rotated.${robot}`
export function readRotated(store: Store, robot: string | readonly string[]): boolean {
  // The first id that has a saved choice decides (the robot key, then the old id), so turning it off sticks.
  try {
    for (const id of typeof robot === 'string' ? [robot] : robot) { const v = store.getItem(ROTATED(id)); if (v !== null) return v === '1' }
    return false
  } catch { return false }
}
export function writeRotated(store: Store, robot: string, rotated: boolean): void {
  try { store.setItem(ROTATED(robot), rotated ? '1' : '0') } catch { /* not remembered */ }
}

/** The line under the map: when it was saved, by which role on which laptop, how many slots are set, and from when it is in effect. A slot that vanished after two laptops edited has a visible cause here. */
export function savedLine(map: PowerMap): string {
  const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const slots = new Set(map.boards.flatMap((b) => b.slots.filter((s) => s.feeds !== null || s.breaker !== null).map((s) => `${b.id}:${s.slot}`))).size
  const count = slots === 0 ? 'no slots set' : `${slots} slot${slots === 1 ? '' : 's'} set`
  return `Saved ${day(map.when)} by ${map.by.role} on laptop ${map.by.device.slice(0, 8)} · ${count} · in effect from ${day(map.from)}`
}
