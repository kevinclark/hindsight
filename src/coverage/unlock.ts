/**
 * What would let a rule that didn't run, run. A skip reason says what was missing; this reads it and names the one
 * thing that would change that: a file beside the robot log, a signal the robot code logs (or logs faster), a key in
 * the robot profile, or the Hindsight companion. Reasons that say the match simply didn't happen that way (never
 * enabled, not on the field, too few steps) have no unlock; text nobody listed is shown as it is, under "another reason".
 *
 * It reads the reason text, not a field of the report, so it works on every summary an older Hindsight saved. The
 * phrases come from their producers (rules/view.ts, rules/run.ts), and tests/unlock.test.ts runs real analyses and fails
 * on any part that lands in `other`.
 */
import { ruleById, RULES } from '../rules/index.ts'
import { NO_PROFILE_FITS, NO_WATCHED_DEVICE, PROFILE_DOESNT_FIT } from '../rules/run.ts'
import { NO_KEY } from '../rules/view.ts'
import type { Severity } from '../rules/rule.ts'
import type { MatchSummary } from '../session/summary.ts'
import { gapIn, parts } from './coverage.ts'

export type Unlock =
  | { kind: 'file'; file: '.dslog' | '.dsevents' | '.hoot' }
  | { kind: 'signal'; keys: string[]; faster?: true }
  | { kind: 'profile' }
  | { kind: 'companion' }

export type Placed = { unlock: Unlock } | { situational: string } | { other: string }

/** The same words for the Driver Station files wherever a page says how to get them. */
export const DS_FILES_FIX = "Copy the Driver Station laptop's Log Files folder (C:\\Users\\Public\\Documents\\FRC\\Log Files) to a USB key, then add it in the Library."

/** Reasons that say the match didn't happen that way: nothing to add would change them. */
const SITUATIONAL: RegExp[] = [
  /^the robot was never enabled$/,
  /^not a match on the field$/,
  /^no match in this log$/,
  /^no auto on the field in this log$/,
  /^the leader held a steady speed for only /,
  /^too few current steps/,
  /^no motor current to compare with$/,
  /^only \d+ accepted poses? in the match/,
  /^it never (?:moved|turned) while enabled$/,
  /^charge past [\d.]+ Ah: no healthy battery/,
  /^no battery voltage logged in the \d+ s before auto \(the log started too late\)$/,
  /^the log ends during auto: /,
  /^the log starts mid-auto: /,
  /^the auto chooser was first logged after auto started/,
]

/** A file the rule asks for: onlyIn()'s "load this match's .dsevents", ds-log-truncated's "no .dslog loaded". A part that only names a file it read (".hoot: not lined up") is not one. */
const FILE_NAMED = /(?:load this match's|no) \.(dslog|dsevents|hoot)\b/
const SLOW_LABELS = /^(.+?) (?:is|are) logged about /

/** One part of a skip reason (as coverage.ts `parts` splits it): what would let the rule run, or why nothing would. */
export function placePart(part: string): Placed {
  const file = FILE_NAMED.exec(part)?.[1]
  if (file) return { unlock: { kind: 'file', file: `.${file}` as '.dslog' | '.dsevents' | '.hoot' } }
  if (isProfileGap(part)) return { unlock: { kind: 'profile' } }
  if (part.startsWith(NO_WATCHED_DEVICE)) return { unlock: { kind: 'companion' } }
  const slow = SLOW_LABELS.exec(part)?.[1]
  if (slow) return { unlock: { kind: 'signal', keys: slow.split(/, | and /), faster: true } }
  const key = /^missing (.+)$/.exec(part)?.[1]
  if (key) return { unlock: { kind: 'signal', keys: [key] } }
  // mech/stuck-state's own text: none of the profile's driver request keys is in the log.
  const requests = /^none of the driver request keys is in this log \((.+)\)$/.exec(part)?.[1]
  if (requests) return { unlock: { kind: 'signal', keys: requests.split(', ') } }
  // A situational reason may still carry its motor's name in front ("Hood: no match in this log").
  const bare = part.replace(/^[^/:;]+: /, '')
  if (SITUATIONAL.some((re) => re.test(part) || re.test(bare))) return { situational: part }
  return { other: part }
}

/** The robot profile has no key, no such item, or doesn't fit the log. */
function isProfileGap(part: string): boolean {
  return gapIn(part) !== null || part.includes(NO_KEY) || part.includes('(not in the robot profile)')
    || part.startsWith('the robot profile ') || part.startsWith(NO_PROFILE_FITS) || part.startsWith(PROFILE_DOESNT_FIT)
}

export interface UnlockRule { rule: string; partly: boolean; parts: string[] }
export interface UnlockGroup { unlock: Unlock; rules: UnlockRule[] }
export interface Unlocks { groups: UnlockGroup[]; situational: UnlockRule[]; other: UnlockRule[] }

/** A stable id for grouping across matches. */
export function unlockKey(u: Unlock): string {
  if (u.kind === 'file') return `file:${u.file}`
  if (u.kind === 'signal') return u.faster ? 'signal:faster' : 'signal'
  return u.kind
}

/** What is missing, as a noun phrase that heads a group in Match review and a line in the Session view. */
export function unlockWords(u: Unlock): string {
  switch (u.kind) {
    case 'file': return u.file === '.hoot' ? 'A .hoot (experimental, not counted)' : `A ${u.file}`
    case 'signal': return u.faster ? 'A signal logged too slowly' : "A signal the robot code doesn't log"
    case 'profile': return 'A key in the robot profile'
    case 'companion': return 'The Hindsight companion'
  }
}

/** What to do about it, in words. */
export function unlockFix(u: Unlock): string {
  switch (u.kind) {
    case 'file': return u.file === '.hoot'
      ? 'Turn on Phoenix signal logging in the robot code (the students\' change); the Devices tab and the experimental device-fault check read it.'
      : DS_FILES_FIX
    case 'signal': return 'The Logging tab of any match lists each signal and its key.'
    case 'profile': return 'Add the key to the robot profile (Tools ▾ Robot profile); if the robot doesn\'t log it yet, that comes first.'
    case 'companion': return 'Add the Hindsight companion library to the robot code (companion/README.md).'
  }
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** How urgent a rule is: severity, then its place in RULES (the things that cost the match come first). */
function rank(rule: string): number {
  const i = RULES.findIndex((r) => r.id === rule)
  return SEVERITY_ORDER[ruleById(rule)?.severity ?? 'info'] * 1000 + (i < 0 ? RULES.length : i)
}

const byRank = (a: UnlockRule, b: UnlockRule) => rank(a.rule) - rank(b.rule)
const worstOf = (rules: UnlockRule[]) => Math.min(...rules.map((r) => rank(r.rule)))
const isHoot = (u: Unlock) => u.kind === 'file' && u.file === '.hoot'

/** Groups worst rule first; the .hoot group, which is experimental, last. */
function byWorstRule(a: UnlockGroup, b: UnlockGroup): number {
  return Number(isHoot(a.unlock)) - Number(isHoot(b.unlock)) || worstOf(a.rules) - worstOf(b.rules)
}

/** Skipped rules (and the experimental tier's) grouped by what would let them run, worst rule first. */
export function unlocks(skipped: { rule: string; reason: string }[], experimental: { rule: string; reason: string }[] = []): Unlocks {
  const groups = new Map<string, UnlockGroup>()
  const situational: UnlockRule[] = []
  const other: UnlockRule[] = []
  for (const s of [...skipped, ...experimental]) {
    const partly = s.reason.startsWith('partly checked')
    for (const part of parts(s.reason)) {
      const placed = placePart(part)
      if ('unlock' in placed) {
        const key = unlockKey(placed.unlock)
        const group = groups.get(key) ?? { unlock: copyOf(placed.unlock), rules: [] }
        groups.set(key, group)
        mergeSignalKeys(group.unlock, placed.unlock)
        addPart(group.rules, s.rule, partly, part)
      } else addPart('situational' in placed ? situational : other, s.rule, partly, part)
    }
  }
  return {
    groups: [...groups.values()].map((g) => ({ ...g, rules: g.rules.sort(byRank) })).sort(byWorstRule),
    situational: situational.sort(byRank),
    other: other.sort(byRank),
  }
}

/** A rule's entry in a list, made on first use, holding each distinct part once. */
function addPart(rules: UnlockRule[], rule: string, partly: boolean, part: string): void {
  const entry = rules.find((r) => r.rule === rule) ?? rules[rules.push({ rule, partly, parts: [] }) - 1]
  if (!entry.parts.includes(part)) entry.parts.push(part)
}

const copyOf = (u: Unlock): Unlock => (u.kind === 'signal' ? { ...u, keys: [...u.keys] } : { ...u })

/** A signal group names every key its parts named. */
function mergeSignalKeys(into: Unlock, from: Unlock): void {
  if (into.kind !== 'signal' || from.kind !== 'signal') return
  for (const k of from.keys) if (!into.keys.includes(k)) into.keys.push(k)
}

/** What a session says about one kind of missing thing. */
export interface SessionUnlock {
  key: string
  unlock: Unlock
  /** Matches where any of its rules was not checked, or only partly. */
  matches: number
  rules: { rule: string; title: string; notChecked: number; partly: number }[]
}

/**
 * The Session view's block: every rule reason of every match (not checked, or quiet/fired with a "partly checked"
 * reason), grouped by what would let it run, worst rule first. A not-checked cell whose reason is missing (a match in
 * several logs drops it) says nothing and is left out.
 */
export function sessionUnlocks(matches: MatchSummary[]): SessionUnlock[] {
  const found = new Map<string, SessionUnlock & { seen: Map<string, { notChecked: number; partly: number }> }>()
  for (const m of matches) {
    const here = new Set<string>()
    for (const [rule, cell] of Object.entries(m.rules)) {
      const partly = cell.reason?.startsWith('partly checked') ?? false
      if (!cell.reason || (cell.status !== 'not checked' && !partly)) continue
      for (const g of unlocks([{ rule, reason: cell.reason }]).groups) {
        const key = unlockKey(g.unlock)
        const entry = found.get(key) ?? { key, unlock: copyOf(g.unlock), matches: 0, rules: [], seen: new Map() }
        found.set(key, entry)
        if (g.unlock.kind === 'signal' && entry.unlock.kind === 'signal') mergeSignalKeys(entry.unlock, g.unlock)
        here.add(key)
        const count = entry.seen.get(rule) ?? { notChecked: 0, partly: 0 }
        entry.seen.set(rule, count)
        if (partly) count.partly++
        else count.notChecked++
      }
    }
    for (const key of here) found.get(key)!.matches++
  }
  return [...found.values()].map(({ seen, ...g }) => ({
    ...g,
    rules: [...seen].map(([rule, c]) => ({ rule, title: ruleById(rule)?.title ?? rule, ...c })).sort((a, b) => rank(a.rule) - rank(b.rule)),
  })).sort((a, b) => Number(isHoot(a.unlock)) - Number(isHoot(b.unlock)) || Math.min(...a.rules.map((r) => rank(r.rule))) - Math.min(...b.rules.map((r) => rank(r.rule))))
}
