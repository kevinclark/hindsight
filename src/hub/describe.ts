/**
 * What a log says about itself, for filing it: when it was recorded, which event and match, which battery and robot.
 * A pure function of the file's name and bytes, built on the readers and the match model the rest of Hindsight uses
 * (no second parser). A .hoot is never opened: Hindsight has no hoot reader and CTRE's converter must not be bundled
 * (AGENTS.md), so it is filed by the time in its name.
 */
import { openWpilog } from '../readers/wpilog.ts'
import { readDslog, dslogEndEpoch } from '../readers/dslog.ts'
import { readDsevents, dseventsEndEpoch } from '../readers/dsevents.ts'
import { buildMatch, has, num, values, type Match } from '../match/match.ts'
import { heldAt } from '../match/series.ts'
import { chooseProfile, type ProfileChoice } from '../profiles/choose.ts'
import { codeIdentity } from '../profiles/formats.ts'
import type { RobotProfile } from '../profiles/types.ts'
import { PROFILES, profileId } from '../profiles/index.ts'
import { playedAt } from '../session/summary.ts'
import { hootName, nameInstant } from './dates.ts'
import { kindOf, type LogMeta, type LogRobot } from './types.ts'

/** A robot log this small with no enabled time is a stub. */
export const STUB_BYTES = 1 << 20

const NOTHING: Omit<LogMeta, 'kind'> = {
  playedAt: null, dateSource: 'unknown', wall: null, matchWindow: null, event: '', matchType: null, matchNumber: null,
  onField: false, batteryId: null, roboRio: null, edition: null, robot: null, build: null, stub: false, hardwareId: null,
}

/** Read one log. Throws, with a reason a student can read, when the file is not what its name says. */
export function describeLog(name: string, bytes: Uint8Array): LogMeta {
  const kind = kindOf(name)
  if (kind === null) throw new Error('not a .wpilog, .hoot, .dslog or .dsevents')
  if (kind === 'wpilog') return describeWpilog(name, bytes)
  if (kind === 'hoot') return describeHoot(name)
  if (kind === 'dslog') {
    const file = readDslog(bytes)
    return { ...NOTHING, kind, playedAt: file.startEpochSeconds * 1000, dateSource: 'driver station clock', wall: { start: file.startEpochSeconds * 1000, end: dslogEndEpoch(file) * 1000 } }
  }
  const file = readDsevents(bytes)
  return { ...NOTHING, kind, playedAt: file.startEpochSeconds * 1000, dateSource: 'driver station clock', wall: { start: file.startEpochSeconds * 1000, end: dseventsEndEpoch(file) * 1000 } }
}

/** A hoot file, from its name alone. */
export function describeHoot(name: string): LogMeta {
  const parsed = hootName(name)
  return { ...NOTHING, kind: 'hoot', playedAt: parsed?.at ?? null, dateSource: parsed ? 'file name' : 'unknown', hardwareId: parsed?.hardwareId ?? null }
}

function describeWpilog(name: string, bytes: Uint8Array): LogMeta {
  if (bytes.length < 12) throw new Error(bytes.length === 0 ? 'the file is empty' : 'too short to be a .wpilog')
  const log = openWpilog(bytes)
  const { profile, choice } = chooseProfile(log, PROFILES)
  const match = buildMatch(name, log, profile, choice)
  const when = playedAt(match)
  // The clock decides; the file name is the fallback, read in the zone its year used.
  const dated = when.playedAtSource === 'file name' ? { playedAt: nameInstant(name), dateSource: 'file name' as const } : { playedAt: when.playedAt, dateSource: when.playedAtSource }
  const offset = match.epochOffset
  const wallOf = (t: number) => (offset === null ? null : (offset + t) * 1000)
  const [start, end] = [wallOf(match.logStart), wallOf(match.logEnd)]
  const [mStart, mEnd] = [match.matchStart === null ? null : wallOf(match.matchStart), match.matchEnd === null ? null : wallOf(match.matchEnd)]
  const type = last(num(match, match.profile.signals.matchType))
  const number = last(num(match, match.profile.signals.matchNumber))
  const batteryKey = has(match, match.profile.battery.id) ? match.profile.battery.id : null
  const ids = batteryKey ? values<string>(match, batteryKey) : null
  const atStart = ids && match.matchStart !== null ? heldAt(ids, match.matchStart) : undefined
  return {
    ...NOTHING, kind: 'wpilog', ...dated,
    wall: start !== null && end !== null ? { start, end } : null,
    matchWindow: mStart !== null && mEnd !== null ? { start: mStart, end: mEnd } : null,
    event: match.event, matchType: type, matchNumber: number, onField: match.fms,
    batteryId: atStart || null,
    roboRio: firstText(match, ROBORIO_SERIAL), edition: profile.editionKey ? firstText(match, profile.editionKey) : null,
    robot: robotIdentity(profile, choice, codeIdentity(log).codebase),
    build: match.build.sha ? { sha: match.build.sha.slice(0, 7), branch: match.build.branch } : null,
    stub: bytes.length < STUB_BYTES && match.enabled.length === 0,
  }
}

/**
 * The robot a log is from. The profile names it when the log's own Codebase matched a profile (with or without the branch),
 * or when no profile was named but one fit the log's signals. A best guess that does not fit (`misfit`) is not an identity:
 * the log's own Codebase text is recorded instead, with no profile, or null when the log has none.
 */
export function robotIdentity(profile: RobotProfile, choice: ProfileChoice, codebase: string): LogRobot | null {
  const fit = choice.fit && choice.fit.total > 0 ? choice.fit.present / choice.fit.total : null
  const named = choice.how === 'codebase and branch' || choice.how === 'codebase' || (choice.how === 'signals' && !choice.misfit)
  if (named) return { profileId: profileId(profile), name: profile.name, how: choice.how, fit }
  return codebase ? { profileId: null, name: codebase, how: choice.how, fit } : null
}

/** AdvantageKit writes the roboRIO's serial number into every log it records. */
const ROBORIO_SERIAL = '/SystemStats/SerialNumber'

/** The first non-empty text the log holds under a key, or null when the key is missing or only ever empty. */
function firstText(match: Match, key: string): string | null {
  return (has(match, key) ? values<string>(match, key)?.v.find((x) => typeof x === 'string' && x !== '') : undefined) ?? null
}

const last = (series: { v: ArrayLike<number> } | null): number | null => (series && series.v.length ? series.v[series.v.length - 1] : null)
