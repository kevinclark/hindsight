import { describe, expect, it } from 'vitest'
import { isBooleanPlot, type PlotModel } from '../src/ui/plot-data.ts'

const model = (...vs: number[][]): PlotModel => ({
  from: 0, to: 10, unit: '',
  series: vs.map((v, i) => ({ label: `s${i}`, t: v.map((_, j) => j), v })),
})

describe('isBooleanPlot', () => {
  it('is true when every value of every series is 0 or 1', () => {
    expect(isBooleanPlot(model([1, 1, 0, 1], [0, 0, 1]))).toBe(true)
    expect(isBooleanPlot(model([1, 1, 1]))).toBe(true) // constant is still a boolean signal
  })
  it('is false as soon as one value is neither, or one series is numeric', () => {
    expect(isBooleanPlot(model([0, 1, 0.5]))).toBe(false)
    expect(isBooleanPlot(model([0, 1], [0, 2]))).toBe(false)
  })
  it('ignores non-finite values and is false with nothing to plot', () => {
    expect(isBooleanPlot(model([0, NaN, 1]))).toBe(true)
    expect(isBooleanPlot(model([NaN]))).toBe(false)
    expect(isBooleanPlot(model())).toBe(false)
  })
  it('is false when a threshold line needs a numeric axis', () => {
    expect(isBooleanPlot({ ...model([0, 1]), threshold: { value: 1, label: 't' } })).toBe(false)
  })
})
