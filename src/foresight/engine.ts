/**
 * Foresight's check, once: from the records so far to a verdict. The live page calls it every second; the backtest
 * calls it at points along a match log's disabled stretch. Both go through here, so they cannot drift apart.
 *
 *   1. Nothing is judged until SETTLE_SECONDS after robot code start: camera and PhotonVision alerts clear 12.5–18.9 s
 *      after the first record in the CalGames logs (Q13, Q21, P0), so 30 s leaves a margin.
 *   2. The stretch checked runs from then (or AFTER_DISABLE_SECONDS after the robot was last disabled) to now.
 *   3. That stretch is written as a small .wpilog (records.ts) and read by the ordinary match model and rules.
 */
import { hasEntry, openWpilog, type WpilogFile } from '../readers/wpilog.ts'
import { buildMatch, num, type Match } from '../match/match.ts'
import { FORESIGHT_RULES, runRules, type Report } from '../rules/index.ts'
import type { Rule } from '../rules/rule.ts'
import { PROFILES } from '../profiles/index.ts'
import { chooseProfile, PROFILE_FIT_MIN, profileKeys, type ProfileChoice } from '../profiles/choose.ts'
import { foresightKeys } from './keys.ts'
import type { RobotProfile } from '../profiles/types.ts'
import type { RecordStore } from './records.ts'
import { verdictFor, type Verdict } from './verdict.ts'
import { PROVEN } from './proven.ts'

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
  rules?: Rule[]
}

export type ForesightResult =
  | { state: 'settling'; secondsLeft: number; reason: string }
  | { state: 'enabled'; reason: string }
  | { state: 'checked'; start: number; end: number; match: Match; report: Report; verdict: Verdict }

/**
 * Foresight reads only the keys its checks need, so whether the profile fits is judged on those keys (the profile's
 * signals that Foresight subscribes to), not on every signal the profile names.
 */
function fitOnSubscribed(log: WpilogFile, profile: RobotProfile, choice: ProfileChoice): ProfileChoice {
  const wanted = new Set(foresightKeys(profile))
  const keys = profileKeys(profile).filter((k) => wanted.has(k))
  const fit = { present: keys.filter((k) => hasEntry(log, k)).length, total: keys.length }
  const misfit = fit.present < PROFILE_FIT_MIN * fit.total
  return { ...choice, fit, misfit, note: misfit ? `Only ${fit.present} of the ${fit.total} signals Foresight reads for "${profile.name}" are coming from this robot, so the checks about specific motors, devices and cameras are not run.` : choice.how === 'codebase' ? choice.note : null }
}

export function evaluateForesight(input: ForesightInput): ForesightResult {
  const { store, now } = input
  const settleAt = input.codeStart + SETTLE_SECONDS
  if (now < settleAt) return { state: 'settling', secondsLeft: settleAt - now, reason: 'start-up settling (camera and time-sync alerts clear in the first ~20 s)' }
  // Enables are looked for from code start, so one that ended just before settling still gets its recovery wait.
  const probeLog = openWpilog(store.windowLog(input.codeStart, now))
  const picked = input.profile ? { profile: input.profile, choice: { how: 'given' as const, note: null, fit: null } } : chooseProfile(probeLog, PROFILES)
  picked.choice = fitOnSubscribed(probeLog, picked.profile, picked.choice)
  // Enabled now? Then nothing; enabled earlier? Then check from a while after the last disable.
  const probe = buildMatch('foresight', probeLog, picked.profile, picked.choice)
  const enabled = num(probe, probe.profile.signals.enabled)
  if (enabled && enabled.v.length && enabled.v[enabled.v.length - 1] > 0.5) return { state: 'enabled', reason: 'the robot is enabled: disable it to check' }
  const lastEnable = probe.enabled.at(-1)
  const start = lastEnable ? Math.max(settleAt, lastEnable.end + AFTER_DISABLE_SECONDS) : settleAt
  if (now < start) return { state: 'settling', secondsLeft: start - now, reason: 'just disabled: letting the battery recover' }
  const match = buildMatch('foresight', openWpilog(store.windowLog(start, now)), picked.profile, picked.choice)
  match.foresight = { start, end: now, lastPassingSha: input.lastPassingSha }
  const report = runRules(match, input.rules ?? FORESIGHT_RULES)
  // The backtest only proved checks on stretches before any enable. After a drive the battery is still recovering
  // (CalGames: 11.7–12.1 V 10 s after the match, 12.3 V after 160 s), so rest voltage stays amber then.
  const unproven: Record<string, string> = lastEnable ? { 'power/rest-voltage': `amber: the robot was driven ${Math.round(now - lastEnable.end)} s ago and the battery is still recovering; proven only before any enable` } : {}
  return { state: 'checked', start, end: now, match, report, verdict: verdictFor(report, PROVEN, unproven) }
}
