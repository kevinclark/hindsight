import { describe, expect, it } from 'vitest'
import { sagError, whatIfRow, whatIfRows } from '../src/power/whatif-rows.ts'
import type { WhatIf } from '../src/power/battery-model.ts'

const none = { minVolts: 5.4, secondsUnder7: 13.1 }
const w = (capAmps: number, mode: 'clip' | 'defer', minVolts: number, secondsUnder7: number): WhatIf => ({ capAmps, mode, minVolts, secondsUnder7 })

describe('what-if rows against the model error', () => {
  it('draws one row for a cap whose two modes both equal no change (to float dust), and says so', () => {
    const rows = whatIfRows(none, [w(60, 'clip', 5.4000001, 13.1), w(60, 'defer', 5.4, 13.1), w(40, 'defer', 6.5, 8)], 0.67)
    expect(rows.map((r) => r.label)).toEqual(['Model, cap 60 A', 'Model, cap 40 A (slower spin-up)'])
    expect(rows[0]).toMatchObject({ sameAsNoChange: true, words: 'same as no change (the cap changes nothing)' })
  })
  it('keeps both modes when they differ', () => {
    const rows = whatIfRows(none, [w(30, 'clip', 7, 2), w(30, 'defer', 6, 5)], 0.5)
    expect(rows.map((r) => r.label)).toEqual(['Model, cap 30 A (dropped)', 'Model, cap 30 A (slower spin-up)'])
  })
  it('marks a change smaller than the sag error as within it, and a larger one not', () => {
    const rows = whatIfRows(none, [w(40, 'defer', 5.5, 12), w(30, 'defer', 6.5, 5)], 0.67)
    expect(rows.map((r) => [r.withinError, r.words])).toEqual([[true, 'within model error'], [false, '']])
  })
  it('marks nothing when there is no error to compare with', () => {
    expect(whatIfRows(none, [w(40, 'defer', 5.5, 12)], null)[0].withinError).toBe(false)
  })
  it('a single row (slider) keeps its mode label when it differs, and says it equals no change when it does not', () => {
    expect(whatIfRow(none, none, 'Model, cap 40 A (dropped)', 0.6)).toMatchObject({ label: 'Model, cap 40 A (dropped)', sameAsNoChange: true })
    expect(whatIfRow(none, { minVolts: 5.45, secondsUnder7: 13 }, 'x', 0.6)).toMatchObject({ withinError: true })
  })
  it('judges by the sag error, else the overall error', () => {
    expect(sagError({ rmse: 0.61, rmseLow: 0.67 })).toBe(0.67)
    expect(sagError({ rmse: 0.61, rmseLow: NaN })).toBe(0.61)
    expect(sagError({ rmse: NaN, rmseLow: NaN })).toBeNull()
  })
})
