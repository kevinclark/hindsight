/**
 * Robot current budget: at the worst moment in the log (the most total current), what would the bus voltage be on the
 * weakest battery in the fleet reference, with the configured limits, or with new ones?
 *
 *   predicted volts = weakest battery's open-circuit voltage − R × total current
 *
 * R is this log's battery + wiring resistance (from current steps). The weakest battery is the lowest point of the
 * fleet reference (src/power/fleet-reference.ts), i.e. a healthy battery near the end of a match.
 */

import type { Match } from '../match/match.ts'
import { valueAt } from '../match/series.ts'
import { num } from '../match/match.ts'
import { buildPowerGrid, replayCap, type WhatIf } from '../power/battery-model.ts'
import { powerReport } from '../power/power-report.ts'
import { FLEET_REFERENCE } from '../power/fleet-reference.ts'
import { limitsReport } from './limits-report.ts'

export interface BudgetRow { group: string; motors: number; observedA: number; capPerMotorA: number; capTotalA: number; active: boolean }

export interface Budget {
  at: number
  weakestOcv: number
  resistanceOhms: number
  otherLoadsA: number
  rows: BudgetRow[]
  /** Three ways to add it up, each with its predicted voltage. */
  scenarios: { name: string; amps: number; volts: number }[]
  /** brownout setting + 1 V */
  floor: number
}

/** `caps` overrides a group's per-motor cap (A), e.g. { Flywheel: 40 } for "what if we set 40 A". */
export function robotBudget(match: Match, caps: Record<string, number> = {}): Budget | null {
  const grid = buildPowerGrid(match)
  const power = powerReport(match)
  if (!grid || !power || power.resistanceOhms === null) return null
  let worst = -1
  for (let i = 0; i < grid.t.length; i++) if (grid.enabled[i] && (worst < 0 || grid.amps[i] > grid.amps[worst])) worst = i
  if (worst < 0) return null
  const limits = limitsReport(match)
  const rows: BudgetRow[] = grid.groups.map((g) => {
    const l = limits.find((x) => x.group === g.name)!
    const capPerMotorA = caps[g.name] ?? l.capPerMotorA
    const observedA = g.amps[worst]
    return { group: g.name, motors: l.motorCount, observedA, capPerMotorA, capTotalA: capPerMotorA * l.motorCount, active: observedA > 5 }
  })
  const other = match.profile.power.otherLoadsAmps
  const weakestOcv = Math.min(...FLEET_REFERENCE.map((p) => p.volts))
  const R = power.resistanceOhms
  const volts = (amps: number) => weakestOcv - R * amps
  const asLogged = other + rows.reduce((s, r) => s + r.observedA, 0)
  const capped = other + rows.reduce((s, r) => s + Math.min(r.observedA, r.capTotalA), 0)
  const allAtCap = other + rows.reduce((s, r) => s + (r.active ? r.capTotalA : r.observedA), 0)
  const setting = num(match, match.profile.signals.brownoutVoltage)
  return {
    at: grid.t[worst], weakestOcv, resistanceOhms: R, otherLoadsA: other, rows,
    scenarios: [
      { name: 'as logged at that moment', amps: asLogged, volts: volts(asLogged) },
      { name: 'that moment, with the limits applied', amps: capped, volts: volts(capped) },
      { name: 'every group that was running, at its full limit', amps: allAtCap, volts: volts(allAtCap) },
    ],
    floor: (setting ? valueAt(setting, Infinity) : 6) + 1,
  }
}

/** Replay the match with one group's supply current capped per motor (charge-conserving: slower, not dropped). */
export function groupWhatIf(match: Match, group: string, capAmps: number): WhatIf | null {
  const grid = buildPowerGrid(match)
  const power = powerReport(match)
  if (!grid || !power?.fit) return null
  return replayCap(grid, power.fit, group, capAmps, 'defer')
}
