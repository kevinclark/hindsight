/**
 * Lining a .hoot up with its robot log. The two files keep different clocks (a .hoot's starts with the CAN bus, the
 * robot log's with the robot program), and their file names are no guide, so the offset comes from the one thing both
 * record: the robot being enabled and disabled. On 12 of our .hoot files with enables, the matched edges agreed to
 * within 0.03-0.13 s, and the clocks drifted at most 0.2 ms per second.
 */

export interface Edge { t: number; on: boolean }

export type Alignment =
  /** robot-log time = hoot time + offset. `spread`: the largest minus the smallest difference among the matched edges. */
  | { offset: number; matched: number; spread: number }
  | { offset: null; why: string }

/** Two edges count as the same moment when they are this close once the offset is applied (seconds). */
export const MATCH_WITHIN_S = 0.5

/**
 * Each change of a 0/1 record list: the times the value became on or off. A file that begins enabled has no edge there:
 * Phoenix can start a new .hoot during a match (one of ours begins enabled, in Teleop), and that first record is no
 * moment the robot log saw.
 */
export function edgesOf(records: { t: number; on: boolean }[]): Edge[] {
  const out: Edge[] = []
  for (let i = 1; i < records.length; i++) if (records[i].on !== records[i - 1].on) out.push({ t: records[i].t, on: records[i].on })
  return out
}

/**
 * The offset that lines up the most enable edges. Each pair of same-direction edges proposes an offset; the one that
 * matches most edges within MATCH_WITHIN_S wins (ties: the smaller spread), refined to the median of its matched
 * differences. It must match at least two edges and MIN_SHARE of the file with fewer, and no other offset may match as
 * many: on 38 of our files the true pairing matched 92-100 % of the edges, a wrong log 17-33 % (two or three edges).
 */
export function align(hoot: Edge[], log: Edge[], hootEnabledThroughout = false): Alignment {
  if (hoot.length === 0) return { offset: null, why: hootEnabledThroughout ? 'the robot was enabled from the start of the .hoot to its end, with no enable or disable to line up by' : 'the .hoot never saw the robot enabled' }
  if (log.length === 0) return { offset: null, why: 'the robot log never saw the robot enabled' }
  const tried: { offset: number; matched: number; spread: number }[] = []
  for (const h of hoot) {
    for (const l of log) {
      if (h.on !== l.on) continue
      const diffs = matchedDiffs(hoot, log, l.t - h.t)
      tried.push({ offset: diffs[Math.floor(diffs.length / 2)], matched: diffs.length, spread: diffs[diffs.length - 1] - diffs[0] })
    }
  }
  const best = tried.sort((a, b) => b.matched - a.matched || a.spread - b.spread)[0]
  const needed = Math.max(2, Math.ceil(MIN_SHARE * Math.min(hoot.length, log.length)))
  if (!best || best.matched < needed) {
    return { offset: null, why: Math.min(hoot.length, log.length) < 2 ? 'one enable or disable in a file is too few to line the two up' : 'the enables and disables in the .hoot don\'t line up with the robot log\'s' }
  }
  if (tried.some((t) => t.matched === best.matched && Math.abs(t.offset - best.offset) > 2 * MATCH_WITHIN_S)) {
    return { offset: null, why: 'the enables and disables line up two different ways' }
  }
  // Matched again from the median, so one stray proposal can't set the offset.
  const diffs = matchedDiffs(hoot, log, best.offset)
  return { offset: round3(diffs[Math.floor(diffs.length / 2)]), matched: diffs.length, spread: round3(diffs[diffs.length - 1] - diffs[0]) }
}

/** The share of the file with fewer edges that must line up. */
export const MIN_SHARE = 0.75

/** For each hoot edge, the difference to the nearest same-direction log edge within MATCH_WITHIN_S of `offset`; sorted. */
function matchedDiffs(hoot: Edge[], log: Edge[], offset: number): number[] {
  const used = new Set<number>()
  const diffs: number[] = []
  for (const h of hoot) {
    let pick = -1
    for (let j = 0; j < log.length; j++) {
      if (used.has(j) || log[j].on !== h.on) continue
      const miss = Math.abs(log[j].t - h.t - offset)
      if (miss <= MATCH_WITHIN_S && (pick < 0 || miss < Math.abs(log[pick].t - h.t - offset))) pick = j
    }
    if (pick >= 0) { used.add(pick); diffs.push(log[pick].t - h.t) }
  }
  return diffs.sort((a, b) => a - b)
}

const round3 = (x: number) => Math.round(x * 1000) / 1000
