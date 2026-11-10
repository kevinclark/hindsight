import type { Match } from '../match/match.ts'

/** "2026-10-18", from the robot's clock when it was set; empty when it never was. Its own file so a caller needs nothing else of the review model. */
export function matchDateOf(m: Match): string {
  const t = m.epochOffset !== null && m.matchStart !== null ? (m.epochOffset + m.matchStart) * 1000 : null
  if (t === null) return ''
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
