/**
 * Rows of a what-if table, drawn against the battery model's own error. Presentation only: the numbers are the
 * model's, untouched. Two things are said in words so the table doesn't claim more than the model can:
 *  - a cap that binds nowhere (or too little to show) gives the "no change" result in both modes: one row says so;
 *  - a change in the lowest voltage smaller than the model's sag error is within that error.
 */
import type { WhatIf } from './battery-model.ts'

export interface Outcome { minVolts: number; secondsUnder7: number }

export interface WhatIfRow {
  label: string
  minVolts: number
  secondsUnder7: number
  /** The cap changes nothing at the precision drawn (0.01 V, 0.1 s): same as "no change". */
  sameAsNoChange: boolean
  /** The lowest voltage moved by less than the model's error (never set when there is no error to compare with). */
  withinError: boolean
  /** Words for the table's last cell: empty for a row outside the model's error. */
  words: string
}

export const SAME = 'same as no change (the cap changes nothing)'
export const WITHIN = 'within model error'
const modeText = (mode: 'clip' | 'defer') => (mode === 'defer' ? 'slower spin-up' : 'dropped')
/** Same as drawn: the replay sums currents again, so an unbinding cap differs from the model's own run by float dust. */
const same = (a: Outcome, b: Outcome) => Math.abs(a.minVolts - b.minVolts) < 0.005 && Math.abs(a.secondsUnder7 - b.secondsUnder7) < 0.05

/** The error to judge a change in lowest voltage by: the sag error, else the overall error, else none. */
export function sagError(fit: { rmse: number; rmseLow: number }): number | null {
  const e = Number.isFinite(fit.rmseLow) ? fit.rmseLow : fit.rmse
  return Number.isFinite(e) ? e : null
}

export function whatIfRows(noChange: Outcome, whatIfs: WhatIf[], errorVolts: number | null): WhatIfRow[] {
  const within = (o: Outcome) => errorVolts !== null && Math.abs(o.minVolts - noChange.minVolts) < errorVolts
  const rows: WhatIfRow[] = []
  const done = new Set<string>()
  for (const w of whatIfs) {
    const key = `${w.capAmps}`
    if (same(w, noChange)) {
      // One row per cap when every mode of that cap leaves the result unchanged.
      if (done.has(key)) continue
      done.add(key)
      rows.push({ label: `Model, cap ${w.capAmps} A`, minVolts: w.minVolts, secondsUnder7: w.secondsUnder7, sameAsNoChange: true, withinError: false, words: SAME })
      continue
    }
    rows.push({ label: `Model, cap ${w.capAmps} A (${modeText(w.mode)})`, minVolts: w.minVolts, secondsUnder7: w.secondsUnder7, sameAsNoChange: false, withinError: within(w), words: within(w) ? WITHIN : '' })
  }
  return rows
}

/** One row for a single cap and mode (the slider, or the Limits tab's what-if). */
export function whatIfRow(noChange: Outcome, w: Outcome, label: string, errorVolts: number | null): WhatIfRow {
  if (same(w, noChange)) return { label, minVolts: w.minVolts, secondsUnder7: w.secondsUnder7, sameAsNoChange: true, withinError: false, words: SAME }
  const within = errorVolts !== null && Math.abs(w.minVolts - noChange.minVolts) < errorVolts
  return { label, minVolts: w.minVolts, secondsUnder7: w.secondsUnder7, sameAsNoChange: false, withinError: within, words: within ? WITHIN : '' }
}
