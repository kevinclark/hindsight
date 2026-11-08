/**
 * The power map: which breaker is in each slot of the robot's power distribution board, and what each slot feeds.
 * Nothing on a CTRE PDP 2.0 reports it, so the pit enters it; it is kept as a line of the shared history file
 * (hindsight-history.jsonl), one whole map per line, and the newest one in effect for a match applies to it.
 *
 * This file is the record's shape, its check on reading (`validPowerMap`, used by `parseHistory`), and the two
 * questions the breaker rules ask of it: which breaker is this motor on (`breakerForMotor`), and which is the main one
 * (`mainBreakerFor`). Contract: docs/contracts/power-map.md.
 */
import type { BoardRole, HistoryEvent } from '../triage/history.ts'

/** Breaker families a PDP slot may hold (curves in breaker-curves.json) and the ATM mini a REV MPM slot holds (no curve yet). */
export const PDP_FAMILIES = ['rev-ato', 'ctre-ato', 'snap-action'] as const
export const MAIN_FAMILIES = ['bussmann', 'optifuse'] as const
export type PdpFamily = (typeof PDP_FAMILIES)[number]
export type MainFamily = (typeof MAIN_FAMILIES)[number]

export interface MapBreaker { family: string; ratingA: number }

export type Feed =
  | { kind: 'motor'; name: string; canId?: number }
  | { kind: 'radio' | 'roborio' | 'mpm' | 'other'; label?: string }

export interface MapSlot { slot: number; breaker: MapBreaker | null; feeds: Feed | null }

export interface MapBoard {
  id: string
  kind: 'ctre-pdp-2' | 'rev-mpm'
  /** An MPM: the slot of another board that feeds it. */
  fedFrom?: { board: string; slot: number } | null
  slots: MapSlot[]
}

/** One history line: the whole map of one robot, in effect from `from` (when the wiring or breakers took effect, apart from `when`, the write). */
export interface PowerMap {
  type: 'power-map'
  v: 1
  /** The robot's profile id (`profileId()`). */
  robot: string
  /** ISO time the breakers took effect. */
  from: string
  main: MainFamily | null
  /** "Every motor is on this", for a motor on no mapped slot. */
  usual: { family: PdpFamily; ratingA: number } | null
  boards: MapBoard[]
  by: { device: string; role: BoardRole }
  seq: number
  when: string
}

const ROLES: readonly string[] = ['software', 'pit', 'drive', 'mentor']
const SLOTS: Record<MapBoard['kind'], number> = { 'ctre-pdp-2': 24, 'rev-mpm': 6 }
const FEED_KINDS: readonly string[] = ['radio', 'roborio', 'mpm', 'other']

const isInt = (v: unknown, from: number, to: number) => typeof v === 'number' && Number.isInteger(v) && v >= from && v <= to
const isRating = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0

function validBreaker(b: any, families: readonly string[]): boolean {
  return b === null || (typeof b === 'object' && b !== null && families.includes(b.family) && isRating(b.ratingA))
}

function validFeed(f: any): boolean {
  if (f === null) return true
  if (typeof f !== 'object' || f === undefined) return false
  if (f.kind === 'motor') return typeof f.name === 'string' && f.name !== '' && (f.canId === undefined || isInt(f.canId, 0, 62))
  return FEED_KINDS.includes(f.kind) && (f.label === undefined || typeof f.label === 'string')
}

function validBoard(b: any): boolean {
  if (typeof b !== 'object' || b === null || typeof b.id !== 'string' || b.id === '' || !Object.hasOwn(SLOTS, b.kind) || !Array.isArray(b.slots)) return false
  if (b.fedFrom !== undefined && b.fedFrom !== null && !(typeof b.fedFrom === 'object' && typeof b.fedFrom.board === 'string' && isInt(b.fedFrom.slot, 0, 23))) return false
  const families = b.kind === 'rev-mpm' ? ['atm'] : PDP_FAMILIES
  for (const s of b.slots) {
    if (typeof s !== 'object' || s === null || !isInt(s.slot, 0, SLOTS[b.kind as MapBoard['kind']] - 1)) return false
    if (!validBreaker(s.breaker, families) || !validFeed(s.feeds)) return false
  }
  return true
}

/** Whether a parsed JSON object is a well-formed power-map line; anything else is kept as an OpaqueEvent. */
export function validPowerMap(e: any): boolean {
  if (e.v !== 1 || typeof e.robot !== 'string' || e.robot === '' || typeof e.from !== 'string' || !Number.isFinite(Date.parse(e.from))) return false
  if (e.main !== null && !MAIN_FAMILIES.includes(e.main)) return false
  if (e.usual !== null && !(typeof e.usual === 'object' && e.usual !== undefined && PDP_FAMILIES.includes(e.usual.family) && isRating(e.usual.ratingA))) return false
  if (!Array.isArray(e.boards) || !e.boards.every(validBoard)) return false
  if (!e.by || typeof e.by.device !== 'string' || !ROLES.includes(e.by.role)) return false
  return Number.isFinite(e.seq) && typeof e.when === 'string'
}

/**
 * The map in effect for a robot at a time: the line with the latest `from` at or before `atIso`; ties go to the
 * higher `seq`, then the later `when`. Null when the robot has none yet by then.
 */
export function powerMapAt(history: readonly HistoryEvent[], robotId: string, atIso: string): PowerMap | null {
  const at = Date.parse(atIso)
  let best: PowerMap | null = null
  for (const e of history) {
    if (e.type !== 'power-map' || e.robot !== robotId || Date.parse(e.from) > at) continue
    if (!best || later(e, best)) best = e
  }
  return best
}

function later(a: PowerMap, b: PowerMap): boolean {
  const from = Date.parse(a.from) - Date.parse(b.from)
  if (from !== 0) return from > 0
  // A seq counts per device, so the later write decides first and a seq only breaks a tie within one device.
  if (a.when !== b.when) return a.when > b.when
  return a.seq > b.seq
}

/** Where a breaker's setting came from: a mapped slot, the map's "usual", or nothing (the fastest legal breaker is assumed). */
export type BreakerSource = 'slot' | 'usual' | 'not set'

export interface MotorBreaker {
  family: string
  ratingA: number
  board?: string
  slot?: number
  /** True when the map puts this motor on a slot (even a slot with no breaker set). */
  mapped: boolean
  source: BreakerSource
}

/** The fastest legal PDP breaker: the one assumed when nothing says (R619, 40 A). */
export const FASTEST_LEGAL: { family: PdpFamily; ratingA: number } = { family: 'snap-action', ratingA: 40 }

/**
 * Which breaker a motor is on. A motor is on the slot whose feed is that motor: the same CAN ID when both have one,
 * else the same name. Not on a slot: the map's `usual`. No map or no usual: the fastest legal 40 A breaker.
 */
export function breakerForMotor(map: PowerMap | null, motorName: string, canId?: number): MotorBreaker {
  let found: { board: string; slot: MapSlot } | null = null
  for (const board of map?.boards ?? []) {
    const slot = board.slots.find((s) => s.feeds?.kind === 'motor' && feedsMotor(s.feeds, motorName, canId))
    if (slot) { found = { board: board.id, slot }; break }
  }
  const usual = map?.usual ?? null
  if (found?.slot.breaker) return { ...found.slot.breaker, board: found.board, slot: found.slot.slot, mapped: true, source: 'slot' }
  const fallback = usual ? { ...usual, source: 'usual' as const } : { ...FASTEST_LEGAL, source: 'not set' as const }
  return { ...fallback, ...(found ? { board: found.board, slot: found.slot.slot } : {}), mapped: found !== null }
}

function feedsMotor(feed: Extract<Feed, { kind: 'motor' }>, name: string, canId?: number): boolean {
  return feed.canId !== undefined && canId !== undefined ? feed.canId === canId : feed.name === name
}

/** The main breaker: the map's, or Bussmann (both Bussmann parts share one curve) with `source: 'assumed'`. */
export function mainBreakerFor(map: PowerMap | null): { family: MainFamily; source: 'map' | 'assumed' } {
  return map?.main ? { family: map.main, source: 'map' } : { family: 'bussmann', source: 'assumed' }
}

/** A short identity for a map line, to tell whether the one in effect changed: where it took effect, who wrote it and when. 'none' for no map. */
export function powerMapStamp(map: PowerMap | null): string {
  return map ? `${map.from}|${map.by.device}|${map.seq}|${map.when}` : 'none'
}
