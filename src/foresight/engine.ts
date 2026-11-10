/**
 * Foresight's check, once: from the records so far to a verdict. The live page calls it every second; the backtest
 * calls it at points along a match log's disabled stretch. Both go through here, so they cannot drift apart.
 *
 *   1. Nothing is judged until SETTLE_SECONDS after robot code start: camera and PhotonVision alerts clear 12.5–18.9 s
 *      after the first record in three 2026 logs, so 30 s leaves a margin.
 *   2. The stretch checked runs from then (or AFTER_DISABLE_SECONDS after the robot was last disabled) to now.
 *   3. That stretch is written as a small .wpilog (records.ts) and read by the ordinary match model and rules.
 *   4. The on-check rules (`onCheck`: mech/pair-decoupled) are graded apart, over every enabled run since code start (or
 *      since the oldest record kept), every second, the robot enabled or not: the pit on-check is the students driving
 *      each mechanism by hand, and 3 of 11 such runs at one event ended with the robot powered off still enabled. While
 *      the robot is enabled only they are shown, and their verdict never reads GO; once it is checked, their findings join
 *      the verdict (amber unless proven).
 */
import { hasEntry, openWpilog, type WpilogFile } from '../readers/wpilog.ts'
import { buildMatch, num, type Match } from '../match/match.ts'
import { FORESIGHT_RULES, LINKS, ONCHECK_RULES, runRules, type Report } from '../rules/index.ts'
import type { Rule } from '../rules/rule.ts'
import { PROFILES } from '../profiles/index.ts'
import { chooseProfile, PROFILE_FIT_MIN, profileKeys, type ProfileChoice } from '../profiles/choose.ts'
import { coupledPairKeys, foresightKeys, RECENT_SECONDS, recentKeys } from './keys.ts'
import type { Interval, NumberSeries } from '../match/series.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { KEEP_SECONDS, type RecordStore } from './records.ts'
import { verdictFor, type Verdict } from './verdict.ts'
import { PROVEN } from './proven.ts'
import { addSnapshotChecks, joinWatched, SNAPSHOT_PROOF, SNAPSHOT_RULES, type CodeSettings, type SnapshotInput } from './snapshot-checks.ts'
import { MatchView } from '../rules/view.ts'
import { hootLine, type HootLine } from '../match/companion.ts'

export const SETTLE_SECONDS = 30
/** After a disable, battery voltage recovers from the load; wait this long before judging rest voltage. Assumed. */
export const AFTER_DISABLE_SECONDS = 10

export interface ForesightInput {
  store: RecordStore
  /** Robot time the robot code started (s). */
  codeStart: number
  /** Robot time now (s): the latest record. */
  now: number
  lastPassingSha: string | null
  /** A profile to use as is (the backtest pins one per log); otherwise chosen from what the robot says it is. */
  profile?: RobotProfile
  /** How that profile was chosen, when the caller chose it (live.ts): a profile no log fits stays a misfit. */
  choice?: ProfileChoice
  rules?: Rule[]
  /** The on-check rules (default ONCHECK_RULES): graded over the enabled runs since code start. */
  oncheckRules?: Rule[]
  /** The robot snapshot dropped on the page, if any (snapshot-checks.ts). Without one, its checks say "not checked". */
  snapshot?: SnapshotInput
  /** The settings the Code panel read from the robot code, for the snapshot to be checked against (snapshot-checks.ts). */
  codeSettings?: CodeSettings
}

/**
 * The on-check rules over the enabled runs since code start (`start` to `end`). Its verdict never reads GO: it judges only
 * these rules, often while the robot is still enabled.
 */
export interface OncheckResult { start: number; end: number; match: Match; report: Report; verdict: Verdict }

export type ForesightResult =
  | { state: 'settling'; secondsLeft: number; reason: string; onchecks: OncheckResult }
  | { state: 'enabled'; reason: string; onchecks: OncheckResult }
  | { state: 'checked'; start: number; end: number; match: Match; report: Report; verdict: Verdict; snapshotUsed: boolean; hoot: HootLine | null; onchecks: OncheckResult }

/**
 * Foresight reads only the keys its checks need, so whether the profile fits is judged on those keys (the profile's
 * signals that Foresight subscribes to), not on every signal the profile names.
 */
function fitOnSubscribed(log: WpilogFile, profile: RobotProfile, choice: ProfileChoice): ProfileChoice {
  // No profile fits: the log's own signals stand in (profiles/choose.ts), and fitting those to the log says nothing.
  if (choice.how === 'signals' && choice.misfit) return choice
  const wanted = new Set(foresightKeys(profile))
  const keys = profileKeys(profile).filter((k) => wanted.has(k))
  const fit = { present: keys.filter((k) => hasEntry(log, k)).length, total: keys.length }
  const misfit = fit.present < PROFILE_FIT_MIN * fit.total
  return { ...choice, fit, misfit, note: misfit ? `Only ${fit.present} of the ${fit.total} signals Foresight reads for "${profile.name}" are coming from this robot, so the checks about specific motors, devices and cameras are not run.` : choice.how === 'codebase' ? choice.note : null }
}

export function evaluateForesight(input: ForesightInput): ForesightResult {
  const { store, now } = input
  const settleAt = input.codeStart + SETTLE_SECONDS
  // Enables are looked for from code start, so one that ended just before settling still gets its recovery wait.
  const probeLog = openWpilog(store.windowLog(input.codeStart, now))
  const picked = input.profile ? { profile: input.profile, choice: input.choice ?? { how: 'given' as const, note: null, fit: null } } : chooseProfile(probeLog, PROFILES)
  picked.choice = fitOnSubscribed(probeLog, picked.profile, picked.choice)
  for (const key of recentKeys(picked.profile)) store.recent.set(key, RECENT_SECONDS)
  const probe = buildMatch('foresight', probeLog, picked.profile, picked.choice)
  keepPairCurrents(store, probe, picked.profile)
  const onchecks = oncheckResult(input, probe)
  // Enabled now? Then only the on-check rules; enabled earlier? Then check from a while after the last disable.
  const enabled = num(probe, probe.profile.signals.enabled)
  if (enabled && enabled.v.length && enabled.v[enabled.v.length - 1] > 0.5) return { state: 'enabled', reason: 'the robot is enabled: the on checks are graded as it runs; disable it for the rest', onchecks }
  if (now < settleAt) return { state: 'settling', secondsLeft: settleAt - now, reason: 'start-up settling (camera and time-sync alerts clear in the first ~20 s)', onchecks }
  const lastEnable = probe.enabled.at(-1)
  const wanted = lastEnable ? Math.max(settleAt, lastEnable.end + AFTER_DISABLE_SECONDS) : settleAt
  if (now < wanted) return { state: 'settling', secondsLeft: wanted - now, reason: 'just disabled: letting the battery recover', onchecks }
  // After KEEP_SECONDS the oldest records are gone: check only what is still known, and say so.
  const pruned = store.prunedTo > wanted
  const start = pruned ? store.prunedTo : wanted
  const words = pruned ? `in the last ${Math.round(KEEP_SECONDS / 60)} min` : lastEnable ? 'since the robot was last driven' : 'since start-up settled'
  const match = buildMatch('foresight', openWpilog(store.windowLog(start, now)), picked.profile, picked.choice)
  match.foresight = { start, end: now, lastPassingSha: input.lastPassingSha, words }
  // The Match tab's links (not its parents, which would add findings), so one problem two checks see is one item in
  // the verdict (verdict.ts).
  const report = runRules(match, input.rules ?? FORESIGHT_RULES, { links: LINKS })
  if (onchecks) joinOnchecks(report, onchecks.report)
  const snapshotUsed = addSnapshotChecks(report, input.snapshot, picked.profile, SETTLE_SECONDS, input.codeSettings, match.build)
  const snapshot = input.snapshot?.snapshot
  if (snapshotUsed && snapshot) joinWatched(report, snapshot, new MatchView(match).watchedDevices())
  // The backtest only proved checks on stretches before any enable. After a drive the battery is still recovering
  // (2026 logs: 11.7–12.1 V 10 s after the match, 12.3 V after 160 s), so rest voltage stays amber then.
  const unproven: Record<string, string> = Object.fromEntries(SNAPSHOT_RULES.map((r) => [r, SNAPSHOT_PROOF]))
  if (lastEnable) unproven['power/rest-voltage'] = `amber: the robot was driven ${Math.round(now - lastEnable.end)} s ago and the battery is still recovering; proven only before any enable`
  // Context only, never in the verdict: whether Phoenix's hoot is recording (from the Hindsight companion).
  const hoot = hootLine(match, { start, end: now }, words)
  return { state: 'checked', start, end: now, match, report, verdict: verdictFor(report, PROVEN, unproven), snapshotUsed, hoot, onchecks }
}

/**
 * The on-check rules over every enabled run since code start: the probe's window, which holds the pairs' currents kept
 * while they ran (keepPairCurrents). Never GO: see OncheckResult.
 */
function oncheckResult(input: ForesightInput, probe: Match): OncheckResult {
  const report = runRules(probe, input.oncheckRules ?? ONCHECK_RULES, { links: LINKS })
  const verdict = verdictFor(report, PROVEN)
  const word = verdict.verdict === 'GO' ? { verdict: 'NOT CHECKED' as const, reason: `on checks only: ${verdict.reason}` } : {}
  return { start: Math.max(input.codeStart, input.store.prunedTo), end: input.now, match: probe, report, verdict: { ...verdict, ...word } }
}

/** The on-check findings and not-checked reasons, added to the check's report (its own meta/not-checked stays out). */
function joinOnchecks(report: Report, onchecks: Report): void {
  report.findings.push(...onchecks.findings.filter((f) => f.rule !== 'meta/not-checked'))
  report.skipped.push(...onchecks.skipped)
  report.crashed.push(...onchecks.crashed)
}

/** Under this a coupled motor isn't running: the stretches its stator currents are kept for start above it (pair-decoupled.ts). */
const PAIR_RUNNING_ROT_PER_S = 5
/** Kept a little either side of the running stretch, so the first and last running records have their current. */
const KEEP_PAD_SECONDS = 0.1

/**
 * Keep each coupled pair's stator currents while the pair ran (records.ts keepDuring): they are fast "updating" keys,
 * kept 30 s only, and the on-check rule reads them minutes later for which motor ran free. Only while either motor ran
 * over 5 rot/s, so a check writes a few seconds of them, not every minute since code start.
 */
function keepPairCurrents(store: RecordStore, probe: Match, profile: RobotProfile): void {
  for (const pair of coupledPairKeys(profile)) {
    const spans = pair.velocity.flatMap((key) => {
      const series = key ? num(probe, key) : null
      return series ? runningSpans(series) : []
    })
    for (const key of pair.stator) if (key) store.keepDuring.set(key, mergeSpans([...(store.keepDuring.get(key) ?? []), ...spans]))
  }
}

/** Where this speed was over the running line, as intervals padded either side. */
function runningSpans(series: NumberSeries): Interval[] {
  const spans: Interval[] = []
  for (let i = 0; i < series.t.length; i++) {
    if (Math.abs(series.v[i]) <= PAIR_RUNNING_ROT_PER_S) continue
    const end = i + 1 < series.t.length ? series.t[i + 1] : series.t[i]
    spans.push({ start: series.t[i] - KEEP_PAD_SECONDS, end: end + KEEP_PAD_SECONDS })
  }
  return mergeSpans(spans)
}

/** Overlapping intervals joined, in time order. */
function mergeSpans(list: Interval[]): Interval[] {
  const out: Interval[] = []
  for (const iv of [...list].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end)
    else out.push({ ...iv })
  }
  return out
}
