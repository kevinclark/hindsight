/**
 * A burst / sustained pair instead of one supply limit, checked against the two things it must protect.
 *
 * Phoenix 6 has two supply settings that work together: SupplyCurrentLimit (the burst cap, for the first moments at
 * the limit) and SupplyCurrentLowerLimit after SupplyCurrentLowerTime (the sustained cap). The burst cap is set by the
 * battery: what the bus voltage does when everything is drawing at once. The sustained cap is set by the 120 A main
 * breaker, which trips on heat over tens of seconds: the sustained caps of everything that can run at once must add
 * up to about 120 A or less.
 *
 * A pinned (stalled) motor is the exception: its supply current is about stator² × R_motor / V_bus, which stays under
 * the supply limit, so the lower limit never engages and only the stator limit governs it.
 */
import type { MotorGroup, RobotProfile } from '../profiles/types.ts'
import { PHOENIX_DEFAULTS } from './limits-report.ts'

const MAIN_BREAKER_A = 120
/** Winding resistance of a Kraken X60 (12 V / 483 A FOC stall to 12 V / 366 A trapezoidal): 25–33 mΩ. Assumed for every motor. */
const MOTOR_OHMS = [0.025, 0.033]
const BUS_VOLTS = 12

export interface PairCheck {
  burstA: number
  lowerA: number
  lowerSeconds: number
  /** True when lowerA / lowerSeconds are Phoenix's defaults because the student hasn't chosen yet. */
  lowerIsDefault: boolean
  /** The burst cap is above the limit the code has today: say plainly not to raise it yet. */
  raisesBurst: boolean
  todaySupplyA: number | null
  /** Sustained caps of the groups that run together added up (this group with the new pair), against the main breaker. */
  sustained: { rows: { group: string; motors: number; perMotorA: number; totalA: number }[]; totalA: number; ok: boolean }
  /**
   * A pinned push: every motor of the drive group stalled at its stator limit (supply ≈ stator² × R / V_bus), added up
   * against the main breaker. Null when the profile has no group named like a drive.
   */
  pinnedDrive: { group: string; motors: number; perMotorA: [number, number]; totalA: [number, number]; ok: boolean } | null
  /** Groups with no supply limit at all (nothing caps their sustained current). */
  unlimited: string[]
}

/** The sustained cap per motor of a group as configured: its lower limit (Phoenix's default if unset), never above its supply limit. */
function sustainedPerMotor(g: MotorGroup): number {
  if (g.limits.supplyEnabled === false) return Infinity // no supply limit at all: nothing caps it
  return Math.min(g.limits.supplyA ?? PHOENIX_DEFAULTS.supplyA, g.limits.supplyLowerA ?? PHOENIX_DEFAULTS.supplyLowerA)
}

/**
 * `running`: the groups that run at the same time (from a match log: those drawing current at its worst moment). The
 * sustained sum adds up those, plus this group; without a log, every group.
 */
export function checkPair(profile: RobotProfile, group: MotorGroup, burstA: number, lowerA: number | null, lowerSeconds: number | null, running?: string[]): PairCheck {
  const lowerIsDefault = !(Number.isFinite(lowerA) && Number.isFinite(lowerSeconds))
  const lower = lowerIsDefault ? Math.min(PHOENIX_DEFAULTS.supplyLowerA, burstA) : lowerA!
  const rows = profile.motorGroups.filter((g) => !running || g.name === group.name || running.includes(g.name)).map((g) => {
    const perMotorA = g.name === group.name ? lower : sustainedPerMotor(g)
    return { group: g.name, motors: g.motors.length, perMotorA, totalA: perMotorA * g.motors.length }
  })
  const totalA = rows.reduce((s, r) => s + r.totalA, 0)
  const today = group.limits.supplyEnabled === false ? null : (group.limits.supplyA ?? PHOENIX_DEFAULTS.supplyA)
  const pinned = (g: MotorGroup): [number, number] | null => {
    const st = g.limits.statorEnabled === false ? null : (g.limits.statorA ?? PHOENIX_DEFAULTS.statorA)
    return st === null ? null : [st * st * MOTOR_OHMS[0] / BUS_VOLTS, st * st * MOTOR_OHMS[1] / BUS_VOLTS]
  }
  const drive = profile.motorGroups.find((g) => /drive/i.test(g.name))
  const drivePinned = drive ? pinned(drive) : null
  return {
    burstA, lowerA: lower, lowerSeconds: lowerIsDefault ? PHOENIX_DEFAULTS.supplyLowerSeconds : lowerSeconds!, lowerIsDefault,
    raisesBurst: today !== null && burstA > today,
    todaySupplyA: today,
    sustained: { rows, totalA, ok: totalA <= MAIN_BREAKER_A },
    pinnedDrive: drive && drivePinned ? {
      group: drive.name, motors: drive.motors.length, perMotorA: drivePinned,
      totalA: [drivePinned[0] * drive.motors.length, drivePinned[1] * drive.motors.length],
      ok: drivePinned[1] * drive.motors.length <= MAIN_BREAKER_A,
    } : null,
    unlimited: rows.filter((r) => !Number.isFinite(r.perMotorA)).map((r) => r.group),
  }
}
