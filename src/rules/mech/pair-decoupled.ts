/**
 * Did two motors on one shaft come apart?
 *
 * Checks: for each coupled pair in the profile (`coupledPairs`: two motors turning one roller), at each of the leader's
 * records while enabled with both motors over 5 rot/s, whether their speeds were more than 4 % apart. A stretch of
 * such records ends at a record within 4 %, a record where either motor is at 5 rot/s or under, or a gap of more than
 * 0.1 s between records. Fires when a stretch lasts 0.5 s or more. The leader's share of the pair's stator current
 * (the median inside the stretch) is evidence, not a gate: the motor that came free spins faster and carries less.
 * Then it says whether the pair ran together again afterwards (1 s or more running within 4 %): a fault that went away
 * within the log is still shown. A record is compared only when the follower's speed was logged within 0.1 s and neither
 * motor reads disconnected (a follower frozen off CAN would otherwise read as apart). A pair that never ran 0.5 s
 * unbroken is "not checked", never quiet: it could not have shown a stretch at the line.
 * Not caught: a motor that stops turning altogether (it is under 5 rot/s, so nothing is compared).
 * mech/motor-running-free (2 s, speed and current) sees the same fault in a match; it explains this finding there
 * (links.ts). This rule's shorter line is for the pit on-check run, where Foresight grades it (`onCheck`).
 * Measured on 59 logs of the 2026 offseason robot's kicker (practice, pit runs and matches): the 32 healthy ones that ran
 * the kicker while enabled never passed 0.14 s apart on the field or 0.10 s in the pit (21 more never ran it while
 * enabled); the six with a kicker motor come free ran 1.16 to 12.5 s (two pit runs 1.42 and 1.53 s, four matches 4.7 to
 * 12.5 s).
 * Why: 2026: a kicker leader came free of its roller in a match. A pit run before the next match showed it (1.2 and 1.4 s
 * apart, the leader carrying 18 % of the pair's current), and nothing flagged it, so the next match played with it.
 */
import { median, plural, round, rule, secs } from '../rule.ts'
import { CTRE_FOLLOWER_API } from '../sources.ts'
import { indexAt } from '../../match/series.ts'
import { inside, MissingSignal, type CoupledPairView, type MatchView, type Signal } from '../view.ts'
import type { Problem } from '../rule.ts'

const RUNNING_ROT_PER_S = 5 // both motors faster than this; judgment
const APART_FRACTION = 0.04 // speeds more than this far apart; judgment
const GAP_SECONDS = 0.1 // a longer gap between records ends a stretch; judgment
const LINE_SECONDS = 0.5 // a stretch this long fires; chosen after seeing the faults
const TOGETHER_AGAIN_SECONDS = 1 // running together this long after the last stretch: it cleared; judgment

export default rule({
  id: 'mech/pair-decoupled',
  title: 'Motors on one shaft came apart',
  severity: 'warning',
  judges: 'fault',
  who: ['pit'],
  needsEnabled: true,
  onCheck: true, // Foresight grades it during the pit on-check run, while the robot is enabled
  meaning: 'Two motors that turn one roller ran at different speeds for a while: one of them is no longer driving the roller, so the other does all the work and the mechanism runs weaker and hotter.',
  causes: [
    { id: 'came-free', cause: 'One motor came free of the roller: a loose or broken pulley, gear, set screw, key or coupling on its shaft', look: 'the motor that ran free (faster, carrying less current): hold the roller and turn that motor\'s shaft by hand' },
    { id: 'belt', cause: 'A belt between a motor and the roller slipping or off', look: 'the belts on both motors: tension, teeth, and whether one has jumped' },
    { id: 'motor-fault', cause: 'One motor cutting out (CAN dropout, brownout, current limit)', look: 'the can/device-dropout and power/limit-not-applied findings for that motor' },
  ],
  nextStep: 'Before the next match, hold the roller and turn each motor\'s shaft by hand: the one that turns on its own has come free. Fix its pulley or coupling.',
  incident: '2026: a kicker leader came free of its roller; the pit run before the next match showed it and that match played with it',
  sources: [
    { ...CTRE_FOLLOWER_API, says: 'A Follower control request makes a Talon copy another Talon\'s output, so the follower is driven the same whether or not it is still turning the roller: only their speeds can tell.' },
  ],
  thresholds: [
    { name: 'running', value: 'both motors over 5 rot/s', basis: 'judgment', how: 'Chosen: the kicker runs at about 12 rot/s, and at a few rot/s a small difference is a large share.' },
    { name: 'apart', value: 'speeds more than 4 % apart', basis: 'judgment', how: 'Chosen. Healthy runs have single records over it (up to 18 % of a burst\'s records), never a long stretch.' },
    { name: 'a stretch ends', value: 'at a record within 4 %, a motor at 5 rot/s or under, or a gap over 0.1 s', basis: 'judgment', how: 'Chosen, so a stretch is records that were all apart, one after the other.' },
    { name: 'stretch apart', value: '0.5 s or more', basis: 'judgment', how: 'Chosen after seeing the faults (one robot, one mechanism, one event): on 59 logs of one robot\'s kicker the 32 healthy ones that ran it never passed 0.14 s and the 6 with a motor come free ran 1.16 to 12.5 s, so the line has 3.6x margin over healthy and 2.3x under the shortest fault.' },
    { name: 'together again', value: 'running within 4 % for 1 s or more after the last stretch', basis: 'judgment', how: 'Chosen: a pit run spins the kicker 1.3 to 3.9 s at a time.' },
  ],
  forEach: 'motorGroup',

  only: (group) => group.coupledPairs.length > 0,
  check(group, match) {
    const problems: Problem[] = []
    for (const pair of group.coupledPairs) {
      const run = pairRun(pair, match)
      if (run.runningSeconds === 0) {
        match.couldNotCheck(`${pair.name} never ran (both motors over ${RUNNING_ROT_PER_S} rot/s) while enabled`)
        continue
      }
      const long = run.stretches.filter((s) => s.seconds >= LINE_SECONDS)
      // Too short a run can't show a stretch at the line: say so, rather than OK.
      if (long.length === 0 && run.longestRun < LINE_SECONDS) {
        match.couldNotCheck(`${pair.name} ran at most ${secs(run.longestRun)} at a time while enabled (needs ${LINE_SECONDS} s to judge)`)
        continue
      }
      if (long.length === 0) continue
      problems.push(apartFinding(pair, long, run))
    }
    return problems
  },
})

export interface Stretch { start: number; end: number; seconds: number; ratio: number; leaderShare: number }
export interface PairRun {
  stretches: Stretch[]
  /** Seconds both motors ran over 5 rot/s while enabled. */
  runningSeconds: number
  /** The longest unbroken run (s) of records compared: both running, no gap over 0.1 s, both current and connected. */
  longestRun: number
  /** Seconds both ran over 5 rot/s, within 4 %, after this time. */
  togetherAfter: (t: number) => number
}
/** The finding for a pair that ran apart: the first long stretch dated, the longest judged. */
function apartFinding(pair: CoupledPairView, long: Stretch[], run: PairRun): Problem {
  const first = long[0]
  const longest = long.reduce((a, b) => (b.seconds > a.seconds ? b : a))
  const last = long[long.length - 1]
  const togetherAfter = run.togetherAfter(last.end)
  const cleared = togetherAfter >= TOGETHER_AGAIN_SECONDS
  const free = freeMotor(pair, longest)
  const leaderShare = round(100 * longest.leaderShare, 0)
  const freeWords = free ? `; ${free} ran free, the leader carrying ${leaderShare} % of the pair's current` : ''
  const clearedWords = cleared ? `; together again for ${secs(togetherAfter)} after` : ''
  const leader = pair.leader.name
  const follower = pair.follower.name
  return {
    about: pair.name,
    likely: free ? ['came-free', 'belt'] : [],
    message: `${leader} and ${follower} ran more than 4 % apart for ${secs(longest.seconds)}${freeWords}${clearedWords}`,
    at: first.start,
    evidence: {
      'longest stretch apart (s)': round(longest.seconds, 2),
      'stretches of 0.5 s or more': long.length,
      'first at (s)': round(first.start, 1),
      [`${leader} / ${follower} speed in it`]: round(longest.ratio, 3),
      [`${leader}: share of the pair's current in it (%)`]: Number.isNaN(longest.leaderShare) ? undefined : leaderShare,
      'ran free': free ?? 'unclear (the faster motor did not carry less current)',
      'running together after the last stretch (s)': round(togetherAfter, 1),
      'cleared later in the log': cleared ? 'yes' : 'no',
    },
    measured: [
      { label: `${pair.name}: longest stretch more than 4 % apart`, value: round(longest.seconds, 2), unit: 's', threshold: LINE_SECONDS, short: 'apart' },
      { label: `${pair.name}: stretches of 0.5 s or more apart`, value: long.length, unit: '', one: `${pair.name}: stretch of 0.5 s or more apart` },
    ],
    plot: { signals: [pair.leader.velocity(), pair.follower.velocity()], unit: 'rot/s', from: first.start - 2, to: Math.max(first.end, longest.end) + 2 },
    nextStep: cleared ? `It came back together within the log (${plural(long.length, 'stretch')} apart, then ${secs(togetherAfter)} together): still turn each motor by hand before the next match, since a coupling that slips only sometimes is loose.` : undefined,
  }
}

/** The motor that came free: faster and carrying less of the current. Null when the two disagree or no current was read. */
function freeMotor(pair: CoupledPairView, s: Stretch): string | null {
  if (Number.isNaN(s.leaderShare)) return null
  if (s.ratio > 1 && s.leaderShare < 0.5) return pair.leader.name
  if (s.ratio < 1 && s.leaderShare > 0.5) return pair.follower.name
  return null
}

/**
 * Every stretch the pair ran apart while enabled, how long it ran at all, and its longest unbroken run. A record is
 * compared only when the follower's speed is current (logged within 0.1 s) and neither motor reads disconnected, so a
 * follower frozen off CAN at its last speed never reads as apart.
 */
export function pairRun(pair: CoupledPairView, match: MatchView): PairRun {
  const leader = pair.leader.velocity()
  const follower = pair.follower.velocity()
  // Current is evidence, not a gate, and the Connected flags are a guard: each read only where logged.
  const leaderAmps = ifLogged(() => pair.leader.stator())
  const followerAmps = ifLogged(() => pair.follower.stator())
  const leaderOn = ifLogged(() => pair.leader.connected())
  const followerOn = ifLogged(() => pair.follower.connected())
  const stretches: Stretch[] = []
  const together: { t: number; seconds: number }[] = []
  let runningSeconds = 0
  let longestRun = 0
  let runStart: number | null = null
  let open: { start: number; last: number; ratios: number[]; shares: number[] } | null = null
  let previous = -Infinity
  const close = (end: number) => {
    if (open) stretches.push({ start: open.start, end, seconds: end - open.start, ratio: median(open.ratios), leaderShare: open.shares.length ? median(open.shares) : NaN })
    open = null
  }
  const endRun = (end: number) => {
    if (runStart !== null) longestRun = Math.max(longestRun, end - runStart)
    runStart = null
  }
  const { t, v } = leader.series
  for (let i = 0; i < t.length; i++) {
    if (!inside(match.enabled, t[i])) continue
    const gap = t[i] - previous
    if (gap > GAP_SECONDS) { if (open) close(open.last); endRun(previous) }
    previous = t[i]
    const a = Math.abs(v[i])
    const b = Math.abs(follower.at(t[i]))
    const current = followerCurrent(follower, t[i]) && leaderOn?.at(t[i]) !== 0 && followerOn?.at(t[i]) !== 0
    const running = current && a > RUNNING_ROT_PER_S && b > RUNNING_ROT_PER_S
    if (!running) { if (open) close(t[i]); endRun(t[i]); continue }
    runningSeconds += Math.min(gap, GAP_SECONDS)
    if (runStart === null) runStart = t[i]
    longestRun = Math.max(longestRun, t[i] - runStart)
    const ratio = a / b
    if (Math.abs(ratio - 1) <= APART_FRACTION) {
      if (open) close(t[i])
      together.push({ t: t[i], seconds: Math.min(gap, GAP_SECONDS) })
      continue
    }
    if (!open) open = { start: t[i], last: t[i], ratios: [], shares: [] }
    open.last = t[i]
    open.ratios.push(ratio)
    const ia = Math.abs(leaderAmps?.at(t[i]) ?? NaN)
    const ib = Math.abs(followerAmps?.at(t[i]) ?? NaN)
    if (ia + ib > 1) open.shares.push(ia / (ia + ib))
  }
  if (open) close((open as { last: number }).last)
  const togetherAfter = (after: number) => together.filter((x) => x.t > after).reduce((sum, x) => sum + x.seconds, 0)
  return { stretches, runningSeconds, longestRun, togetherAfter }
}

/** Is the follower's speed at t a fresh one: logged within 0.1 s before it? */
function followerCurrent(follower: Signal, t: number): boolean {
  const i = indexAt(follower.series.t, t)
  return i >= 0 && t - follower.series.t[i] <= GAP_SECONDS
}

/** A signal the rule can do without: null when the profile or the log doesn't have it. */
function ifLogged(read: () => Signal): Signal | null {
  try {
    return read()
  } catch (e) {
    if (e instanceof MissingSignal) return null
    throw e
  }
}
