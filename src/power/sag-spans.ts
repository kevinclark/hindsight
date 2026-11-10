/** Stub, so the tests load and fail one by one (red run). Replaced by the real module in the next commit. */
import type { Match } from '../match/match.ts'

export const MIN_SPAN_S = 0
export const MERGE_GAP_S = 0
export const LOOK_BEFORE_S = 0
export const SPAN_CAP = 0

export interface Load { group: string; amps: number }
export interface SagSpan {
  start: number; end: number; seconds: number; lowestVolts: number; lowestAt: number
  stateAtStart: string | null
  atLowest: Load[]; during: Load[] | null; before: Load[]
}
export interface SagSpans {
  line: number; mode: 'stretches' | 'lowest-points'; reason: string | null
  spans: SagSpan[]; totalSpans: number; secondsUnderLine: number
}

export function sagSpansUncapped(_match: Match): { line: number; spans: SagSpan[] } | null { return null }
export function buildSagSpans(_match: Match): SagSpans | null { return null }
