/**
 * Foresight's check, once: from the records so far to a verdict. The live page calls it every second; the backtest
 * calls it at points along a match log's disabled stretch. Both go through here, so they cannot drift apart.
 *
 *   1. Each check waits its own start-up settle after robot code start (SETTLE_BY_RULE): the camera, time-sync, alert
 *      and controller checks SETTLE_SECONDS (camera and PhotonVision alerts clear 12.5–18.9 s after the first record in
 *      three 2026 logs), values-updating a shorter one, and the static checks (build, devices, zeros, temperatures,
 *      battery) none: on 36 pit logs of one event, judging them from the first second added no false alarm once
 *      foresight/zero-sanity stopped reading a position not yet logged as NaN° off. A check still settling is listed as
 *      not checked, and the verdict can't read GO until none is.
 *   2. Each check's stretch runs from its settle (or AFTER_DISABLE_SECONDS after the robot was last disabled) to now.
 *   3. That stretch is written as a small .wpilog (records.ts) and read by the ordinary match model and rules; checks
 *      that start at the same moment share one, and the links run over all their findings together.
 *   4. The on-check rules (`onCheck`: mech/pair-decoupled) are graded apart, over every enabled run since code start (or
 *      since the oldest record kept), every second, the robot enabled or not: the pit on-check is the students driving
 *      each mechanism by hand, and 3 of 11 such runs at one event ended with the robot powered off still enabled. While
 *      the robot is enabled only they are shown, and their verdict never reads GO; once it is checked, their findings join
 *      the verdict (amber unless proven).
 */
import { hasEntry, openWpilog, type WpilogFile } from '../readers/wpilog.ts'
import { buildMatch, num, type Match } from '../match/match.ts'
import { FORESIGHT_RULES, LINKS, ONCHECK_RULES, runRules, type Report } from '../rules/index.ts'
import { consolidate, worstFirst } from '../rules/run.ts'
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
/**
 * Each check's start-up settle (s after robot code start) where it isn't 0, from the on-check backtest's first 90 s of
 * 36 pit logs of one event with no settle at all (docs/measurements.md): the camera and alert checks flagged start-up
 * camera drop-outs on 17 logs (vision/time-sync from 14.5–20.2 s), so SETTLE_SECONDS; the controllers check flagged a
 * missing controller on 9 logs, 3 of which cleared by themselves, the last at 25.4 s, so SETTLE_SECONDS too;
 * values-updating flagged nothing there, but an earlier replay saw it amber at 7–11 s on 3 logs, so a shorter settle.
 */
export const VALUES_SETTLE_SECONDS = 20
export const SETTLE_BY_RULE: Record<string, number> = {
  'vision/stale': SETTLE_SECONDS, 'vision/time-sync': SETTLE_SECONDS, 'alerts/passthrough': SETTLE_SECONDS, 'foresight/camera-sees-tag': SETTLE_SECONDS,
  'foresight/controllers': SETTLE_SECONDS, 'foresight/values-updating': VALUES_SETTLE_SECONDS,
}
/**
 * Context in Foresight, never NO-GO: the battery's rest voltage. Pit checks run on a practice battery and a fresh one goes
 * in at the queue, after the last moment Foresight can see the robot (the field guard closes it at the field), so the
 * battery Foresight reads is not the match battery.
 */
export const CONTEXT_RULES = new Set(['power/rest-voltage'])
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
  /** Each check's start-up settle in seconds (default SETTLE_BY_RULE, else 0); the backtest passes 0 to measure them. */
  settle?: (rule: string) => number
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
  const lastEnable = probe.enabled.at(-1)
  const afterDrive = lastEnable ? lastEnable.end + AFTER_DISABLE_SECONDS : -Infinity
  if (now < afterDrive) return { state: 'settling', secondsLeft: afterDrive - now, reason: 'just disabled: letting the battery recover', onchecks }
  const rules = input.rules ?? FORESIGHT_RULES
  const settleOf = input.settle ?? ((rule: string) => SETTLE_BY_RULE[rule] ?? 0)
  const waiting = rules.filter((r) => now < input.codeStart + settleOf(r.id))
  // Checks that start their stretch at the same moment share it. After KEEP_SECONDS the oldest records are gone: check
  // only what is still known, and say so.
  const startOf = (r: Rule) => Math.max(input.codeStart + settleOf(r.id), afterDrive, store.prunedTo)
  const byStart = new Map<number, Rule[]>()
  for (const r of rules.filter((x) => !waiting.includes(x))) byStart.set(startOf(r), [...(byStart.get(startOf(r)) ?? []), r])
  const stretches = [...byStart].sort((a, b) => a[0] - b[0]).map(([start, group]) => {
    const words = store.prunedTo >= start ? `in the last ${Math.round(KEEP_SECONDS / 60)} min` : lastEnable ? 'since the robot was last driven' : start > input.codeStart ? 'since start-up settled' : 'since the robot code started'
    const match = buildMatch('foresight', openWpilog(store.windowLog(start, now)), picked.profile, picked.choice)
    match.foresight = { start, end: now, lastPassingSha: input.lastPassingSha, words }
    return { start, words, match, report: runRules(match, group) }
  })
  // The first (longest) stretch is the one the page reads values from; it always runs, since the static checks never wait.
  const first = stretches[0] ?? { start: now, words: 'now', match: probe, report: { findings: [], skipped: [], crashed: [] } }
  const { start, words, match } = first
  const report = joinStretches(stretches.map((x) => x.report), rules)
  for (const r of waiting) report.skipped.push({ rule: r.id, reason: `start-up settling: checked from ${settleOf(r.id)} s after the robot code starts (${Math.ceil(input.codeStart + settleOf(r.id) - now)} s left)` })
  joinOnchecks(report, onchecks.report)
  const snapshotUsed = addSnapshotChecks(report, input.snapshot, picked.profile, SETTLE_SECONDS, input.codeSettings, match.build)
  const snapshot = input.snapshot?.snapshot
  if (snapshotUsed && snapshot) joinWatched(report, snapshot, new MatchView(match).watchedDevices())
  const unproven: Record<string, string> = Object.fromEntries(SNAPSHOT_RULES.map((r) => [r, SNAPSHOT_PROOF]))
  const verdict = settled(verdictFor(report, PROVEN, unproven, CONTEXT_RULES), waiting, (r) => input.codeStart + settleOf(r) - now)
  // Context only, never in the verdict: whether Phoenix's hoot is recording (from the Hindsight companion).
  const hoot = hootLine(match, { start, end: now }, words)
  return { state: 'checked', start, end: now, match, report, verdict, snapshotUsed, hoot, onchecks }
}

/**
 * The reports of the stretches as one: every finding (the Match tab's links run over all of them together, not its
 * parents, which would add findings, so one problem two checks see is one item in the verdict), every not-checked
 * reason and crash. Each stretch's own "not checked" summary is left out (verdict.ts reads `skipped`).
 */
function joinStretches(reports: Report[], rules: Rule[]): Report {
  const crashed = reports.flatMap((r) => r.crashed)
  const findings = reports.flatMap((r) => r.findings.filter((f) => f.rule !== 'meta/not-checked'))
  consolidate(findings, { links: LINKS }, crashed)
  return { findings: findings.sort(worstFirst(rules)), skipped: reports.flatMap((r) => r.skipped), crashed }
}

/** A verdict that would read GO while some checks still settle reads NOT CHECKED, naming them and how long is left. */
function settled(verdict: Verdict, waiting: Rule[], left: (rule: string) => number): Verdict {
  if (verdict.verdict !== 'GO' || !waiting.length) return verdict
  const longest = Math.ceil(Math.max(...waiting.map((r) => left(r.id))))
  return { ...verdict, verdict: 'NOT CHECKED', reason: `start-up settling: ${waiting.length} check${waiting.length === 1 ? '' : 's'} (cameras, alerts, controllers) start within ${longest} s; ${verdict.reason} so far` }
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
