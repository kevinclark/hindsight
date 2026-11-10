/**
 * Each motor's drag: its median stator current at a steady speed, per speed band. Friction is torque, so a tight belt
 * or a bent shaft draws more current at the same speed than the motor did in its own earlier matches.
 *
 * Only samples where the motor is on CAN (its Connected flag true at t-0.1, t and t+0.1 s: a controller that dropped
 * off CAN holds its last readings), the robot is enabled at those three instants too, and the speed is steady (|v| changes by at most 2 % over
 * the 0.2 s around t). Bands are powers of 1.25 of the motor's own velocity unit, so they need no unit; a band
 * with under 2 s of steady running is dropped. No rule, no threshold: Session -> Trends compares a band across matches.
 */

import { has, num, type Match } from '../match/match.ts'
import { median, resample } from '../match/series.ts'
import { buildCurrentGrid, DT } from './battery-model.ts'

/** Band edges are powers of this. */
export const BAND_RATIO = 1.25
/** Steady: |v| at t+0.1 and t-0.1 differ by at most this share of |v| at t. */
export const STEADY_SHARE = 0.02
/** Samples below this speed (in the motor's own unit) are not running. */
export const MIN_SPEED = 1
/** A band needs this many seconds of steady running to be kept. */
export const MIN_BAND_SECONDS = 2
const HALF_WINDOW = Math.round(0.1 / DT)

export interface DragBand {
  band: number
  /** The band's speed edges, in the motor's velocity unit: BAND_RATIO^band to BAND_RATIO^(band+1). */
  lo: number
  hi: number
  /** Median |stator current| over the band's steady samples, A. */
  amps: number
  seconds: number
}

export interface MotorDrag {
  motor: string
  group: string
  /** The motor's velocity unit, where the signal name says it ("rot/s"). */
  unit?: string
  bands: DragBand[]
}

export const bandOf = (speed: number): number => Math.floor(Math.log(speed) / Math.log(BAND_RATIO) + 1e-9)
export const bandEdges = (band: number): { lo: number; hi: number } => ({ lo: BAND_RATIO ** band, hi: BAND_RATIO ** (band + 1) })

/** The unit a velocity signal's name carries ("VelocityRotPerSec", "VelocityRotsPerSec"), else undefined. */
function unitOf(key: string): string | undefined {
  return /Rots?PerSec/.test(key) ? 'rot/s' : undefined
}

/**
 * The steady-speed bands of one motor on a grid. `connected`: 1 where the controller is on CAN. `enabled`: 1 where
 * the robot is enabled. Pure on its arrays, so tests can feed it synthetic series.
 */
export function dragBands(velocity: ArrayLike<number>, stator: ArrayLike<number>, connected: ArrayLike<number>, enabled: ArrayLike<number>): DragBand[] {
  const byBand = new Map<number, number[]>()
  const n = velocity.length
  for (let i = HALF_WINDOW; i + HALF_WINDOW < n; i++) {
    if (!enabled[i - HALF_WINDOW] || !enabled[i] || !enabled[i + HALF_WINDOW]) continue
    if (!connected[i - HALF_WINDOW] || !connected[i] || !connected[i + HALF_WINDOW]) continue
    const v = Math.abs(velocity[i])
    const a = Math.abs(velocity[i - HALF_WINDOW]), b = Math.abs(velocity[i + HALF_WINDOW])
    const amps = Math.abs(stator[i])
    if (!(v > MIN_SPEED) || !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(amps)) continue
    if (Math.abs(b - a) > STEADY_SHARE * v) continue
    const band = bandOf(v)
    const list = byBand.get(band)
    if (list) list.push(amps)
    else byBand.set(band, [amps])
  }
  return [...byBand]
    .filter(([, xs]) => xs.length * DT >= MIN_BAND_SECONDS - 1e-9)
    .sort((x, y) => x[0] - y[0])
    .map(([band, xs]) => ({ band, ...bandEdges(band), amps: median(xs), seconds: xs.length * DT }))
}

/** Every profile motor that logs stator current, velocity and Connected: its steady-speed bands. Cached as power:drag. */
export function buildDrag(match: Match): MotorDrag[] {
  const cached = match.cache.get('power:drag') as unknown as MotorDrag[] | undefined
  if (cached) return cached
  const out: MotorDrag[] = []
  const grid = buildCurrentGrid(match)
  if (grid) {
    for (const group of match.profile.motorGroups) {
      for (const motor of group.motors) {
        if (!motor.statorCurrent || !motor.velocity || !motor.connected) continue
        if (!has(match, motor.statorCurrent) || !has(match, motor.velocity) || !has(match, motor.connected)) continue
        const stator = num(match, motor.statorCurrent), velocity = num(match, motor.velocity), flag = num(match, motor.connected)
        if (!stator || !velocity || !flag) continue
        const connected = Uint8Array.from(resample(flag, grid.t), (x) => (x === 0 ? 0 : 1))
        out.push({ motor: motor.name, group: group.name, unit: unitOf(motor.velocity), bands: dragBands(resample(velocity, grid.t), resample(stator, grid.t), connected, grid.enabled) })
      }
    }
  }
  match.cache.set('power:drag', out as never)
  return out
}
