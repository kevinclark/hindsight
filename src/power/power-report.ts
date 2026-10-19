/**
 * Everything the Power tab shows, computed once per match:
 *  - the lowest voltage and the margin to the brownout setting
 *  - the deepest sags and which motor groups were drawing at each
 *  - estimated open-circuit voltage against Ah drawn (V + R·I), next to the fleet curve
 *  - the fitted battery model, its error, and flywheel-cap what-ifs
 */

import { num, type Match } from '../match/match.ts'
import { valueAt } from '../match/series.ts'
import {
  buildPowerGrid, fitBattery, ocvCurve, predict, replayCap, resistanceFromSteps, voltageStats,
  type BatteryFit, type OcvPoint, type WhatIf,
} from './battery-model.ts'

export interface Sag {
  t: number
  volts: number
  totalAmps: number
  /** Motor groups by current at the bottom of the sag, largest first. */
  loads: { group: string; amps: number }[]
}

export interface PowerReport {
  minVolts: number
  minAt: number
  brownoutVolts: number
  marginVolts: number
  secondsUnder7: number
  chargeAh: number
  resistanceOhms: number | null
  fit: BatteryFit | null
  /** Model with no change, for comparing against the what-ifs on the same footing. */
  modelNoChange: { minVolts: number; secondsUnder7: number } | null
  ocv: OcvPoint[]
  sags: Sag[]
  whatIfs: WhatIf[]
  whatIfGroup: string
}

const SAG_COUNT = 8
const SAG_SEPARATION_S = 2

export function powerReport(match: Match): PowerReport | null {
  const cached = match.cache.get('power:report') as PowerReport | null | undefined
  if (cached !== undefined) return cached
  const report = compute(match)
  match.cache.set('power:report', report as never)
  return report
}

function compute(match: Match): PowerReport | null {
  const g = buildPowerGrid(match)
  if (!g) return null
  const setting = num(match, match.profile.signals.brownoutVoltage)
  const brownoutVolts = setting ? valueAt(setting, Infinity) : NaN
  let minVolts = Infinity
  let minAt = NaN
  for (let i = 0; i < g.t.length; i++) {
    if (g.enabled[i] && g.volts[i] < minVolts) { minVolts = g.volts[i]; minAt = g.t[i] }
  }
  const stats = voltageStats(g.volts, g.enabled)
  const r = resistanceFromSteps(g)
  const fit = fitBattery(g)

  // Deepest sags: walk samples from lowest voltage up, keeping ones at least 2 s from a sag already kept.
  const order = Array.from(g.t.keys()).filter((i) => g.enabled[i] && Number.isFinite(g.volts[i])).sort((a, b) => g.volts[a] - g.volts[b])
  const sags: Sag[] = []
  for (const i of order) {
    if (sags.length >= SAG_COUNT) break
    if (sags.some((s) => Math.abs(s.t - g.t[i]) < SAG_SEPARATION_S)) continue
    const loads = g.groups.map((x) => ({ group: x.name, amps: x.amps[i] })).filter((x) => x.amps > 1).sort((a, b) => b.amps - a.amps)
    sags.push({ t: g.t[i], volts: g.volts[i], totalAmps: g.amps[i], loads })
  }

  const whatIfGroup = match.profile.whatIfGroup
  const whatIfs: WhatIf[] = []
  if (fit) {
    for (const cap of [60, 40, 30]) {
      whatIfs.push(replayCap(g, fit, whatIfGroup, cap, 'clip'))
      whatIfs.push(replayCap(g, fit, whatIfGroup, cap, 'defer'))
    }
  }
  return {
    minVolts, minAt, brownoutVolts, marginVolts: minVolts - brownoutVolts,
    secondsUnder7: stats.secondsUnder7,
    chargeAh: g.ah[g.ah.length - 1],
    resistanceOhms: r?.ohms ?? null,
    fit,
    modelNoChange: fit ? voltageStats(predict(fit, g.ah, g.amps), g.enabled) : null,
    ocv: r ? ocvCurve(g, r.ohms, 0.25) : [],
    sags,
    whatIfs,
    whatIfGroup,
  }
}

/** Replay one cap for the what-if slider (not cached: the slider moves). */
export function whatIfAt(match: Match, capAmps: number, mode: 'clip' | 'defer'): WhatIf | null {
  const g = buildPowerGrid(match)
  const report = powerReport(match)
  if (!g || !report?.fit) return null
  return replayCap(g, report.fit, report.whatIfGroup, capAmps, mode)
}
