/**
 * The playoff cut-off (ADR 7): from a point the student lead picks, Hindsight analyses and flags change; it offers few fixes.
 * Nothing is blocked. Pure: the setting (an `event-note` line, kind `cut-off`), the timeline and the session come in.
 *
 * The setting is the latest cut-off line for the event: `alliance-selection` (the default, also when there is no line or the
 * text is not one this build reads), a match label such as `Q40` ("after Q40"), or `off`. It has passed when
 *  - it is `off`: never;
 *  - any on-field playoff log is in the session (the schedule or not: the playoffs have begun);
 *  - `alliance-selection`: the team's last scheduled qualification has been played (the schedule's "before playoffs" gap,
 *    `beforePlayoffs` in points.ts). With no schedule there is no last qualification to wait for, so only a playoff log counts;
 *  - `after Qn`: the team's latest on-field qualification is Qn or later.
 */
import type { MatchSummary } from '../session/summary.ts'
import { qualFromStored, type Timeline } from './points.ts'

export const FREEZE_BANNER = 'Playoffs: analysis first. Code changed since the last match is flagged.'
/** The board's wording says where the flag shows. */
export const BOARD_BANNER = "Playoffs: analysis first. Code changed since the last match is flagged on Foresight's queue checklist."


export type CutOffSetting = { kind: 'alliance-selection' } | { kind: 'off' } | { kind: 'after'; match: string; qual: number }

/** The setting a stored cut-off line holds (`text`); anything this build cannot read is the default, never "off". */
export function readCutOff(text: string | undefined | null): CutOffSetting {
  const t = (text ?? '').trim()
  if (t === 'off') return { kind: 'off' }
  const qual = /^Q\d+$/.test(t) ? qualFromStored(t) : null
  if (qual !== null) return { kind: 'after', match: t, qual }
  return { kind: 'alliance-selection' }
}

/** The text a setting is stored as. */
export const cutOffText = (s: CutOffSetting): string => (s.kind === 'after' ? s.match : s.kind)

/** The setting in words, for the control and the banner. */
export const cutOffWords = (s: CutOffSetting): string => (s.kind === 'alliance-selection' ? 'alliance selection (the default)' : s.kind === 'off' ? 'off' : `after ${s.match}`)

export interface CutOff {
  setting: CutOffSetting
  words: string
  passed: boolean
  /** Why it has passed (or, when it has not, what it waits for), for people. */
  why: string
  /** FREEZE_BANNER once passed, else null. */
  banner: string | null
}

type PlayoffLike = Pick<MatchSummary, 'onField' | 'matchType' | 'matchLabel'>

/**
 * An on-field log of the playoffs (elimination): its MatchType (3), else its match label. Both rest on `/DriverStation/MatchType`,
 * which reads practice for about the first second of a log (in the team's 2026 logs), so a log that ends that early is not counted.
 */
export const isPlayoffLog = (m: PlayoffLike): boolean =>
  m.onField && (m.matchType === 3 || /^(elimination|playoff|quarterfinal|semifinal|final)/i.test(m.matchLabel.trim()))

export function cutOffState(setting: CutOffSetting, tl: Pick<Timeline, 'hasSchedule' | 'last' | 'lastQual'>, matches: readonly PlayoffLike[]): CutOff {
  const words = cutOffWords(setting)
  const make = (passed: boolean, why: string): CutOff => ({ setting, words, passed, why, banner: passed ? FREEZE_BANNER : null })
  if (setting.kind === 'off') return make(false, 'the cut-off is off')
  if (matches.some(isPlayoffLog)) return make(true, 'a playoff match has been played')
  const lastQual = tl.last?.qual ?? null
  if (setting.kind === 'after') {
    return lastQual !== null && lastQual >= setting.qual ? make(true, `${setting.match} has been played`) : make(false, `waits for ${setting.match} to be played`)
  }
  if (!tl.hasSchedule || tl.lastQual === null) return make(false, 'no schedule: waits for the first playoff match')
  return lastQual !== null && lastQual >= tl.lastQual ? make(true, `the team's last qualification, Q${tl.lastQual}, has been played`) : make(false, `waits for the team's last qualification, Q${tl.lastQual}`)
}

// ---- the code change flag ----

/** What the live robot reports about its code: the commit (7 or more characters) and whether it had uncommitted changes. */
export interface LiveBuild { sha: string; dirty: boolean }

export interface CodeChangeFlag {
  /** changed: a different commit; uncommitted: the same commit with uncommitted changes in play; unknown: it cannot be compared; same: nothing changed. */
  kind: 'changed' | 'uncommitted' | 'unknown' | 'same'
  /** Amber for every kind but `same`. Never a block, and it never moves the checklist's word. */
  amber: boolean
  text: string
  /** `text` without its mention of uncommitted changes, for when the Code row already says it (one headline per event). */
  plain?: string
  /** The robot has uncommitted changes and the last match did not: all the flag adds over the Code row's own line. */
  robotOnly?: true
  /** The commits, to read the files between them: the last match's and the robot's. Only on `changed`. */
  from?: string
  to?: string
}

const short = (sha: string) => sha.slice(0, 7)
const sameSha = (a: string, b: string) => { const n = Math.min(a.length, b.length); return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase() }

/**
 * After the cut-off: has the robot's code changed since the team's last on-field match? Compares the commit and the dirty flag
 * of the live robot with that match's log. Null before the cut-off or with no on-field match to compare with.
 */
export function codeChangeFlag(cutOff: Pick<CutOff, 'passed'>, live: LiveBuild | null, last: { label: string; build?: { sha: string; uncommitted: boolean } } | undefined): CodeChangeFlag | null {
  if (!cutOff.passed || !last) return null
  const unknown = (text: string): CodeChangeFlag => ({ kind: 'unknown', amber: true, text })
  if (!last.build?.sha) return unknown(`Cannot tell whether the code changed: the log of ${last.label} does not say which code it ran.`)
  if (!live?.sha) return unknown(`Cannot tell whether the code changed since ${last.label}: the robot has not reported its commit yet.`)
  if (!sameSha(live.sha, last.build.sha)) {
    const base = `Code changed since ${last.label}: the robot runs ${short(live.sha)}, ${last.label} ran ${short(last.build.sha)}`
    return { kind: 'changed', amber: true, from: last.build.sha, to: live.sha, text: `${base}${live.dirty ? ', and the robot has uncommitted changes' : ''}.`, plain: `${base}.` }
  }
  if (live.dirty && last.build.uncommitted) return { kind: 'uncommitted', amber: true, text: `Same commit as ${last.label} (${short(live.sha)}), but both ran with uncommitted changes: cannot tell whether they are the same changes.` }
  if (live.dirty) return { kind: 'uncommitted', amber: true, robotOnly: true, text: `Same commit as ${last.label} (${short(live.sha)}), but the robot has uncommitted changes that ${last.label} did not.` }
  if (last.build.uncommitted) return { kind: 'uncommitted', amber: true, text: `Same commit as ${last.label} (${short(live.sha)}), but ${last.label} ran with uncommitted changes that the robot does not have.` }
  return { kind: 'same', amber: false, text: `No code change since ${last.label}: the same commit, ${short(live.sha)}, no uncommitted changes.` }
}

// ---- fixes after the cut-off ----

/** Kevin, 2026-10-24: after the cut-off a fix is offered for reds only; anything else leads with "defer to the end of the event", the fix one click away. */
export const fixFolded = (passed: boolean, level: 'red' | 'amber' | 'low'): boolean => passed && level !== 'red'

export const FIX_FOLDED_SUMMARY = 'Playoffs: defer this to the end of the event first; the fix is here if you need it'
