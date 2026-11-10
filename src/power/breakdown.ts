// Stub for the red run: the real code lands in the next commit.
import type { Match } from '../match/match.ts'

export interface Breakdown { rows: never[]; totalWh: number; enabledSeconds: number; stateNote: string | null }
export function buildBreakdown(_match: Match): Breakdown | null {
  return null
}
