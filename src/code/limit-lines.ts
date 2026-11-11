/**
 * Did the log run the same current limits as the commit the robot profile was copied from? The profile pins one
 * commit (`profile.code.sha`), but a robot runs many commits in a day, most of them with the limits untouched. With the
 * robot-code folder at hand, this reads each motor group's limit files (named in its `limits.where`) at both commits
 * straight from .git and compares the lines that mention CurrentLimit, as `git diff -G'CurrentLimit'` would: lines,
 * never parsed values.
 *
 * When the lines differ, the answer also says what the log's own commit sets (`ran`), read with the profile builder's
 * code model (code-hints.ts) and matched to the group's motors by CAN ID, so the rule can judge the log against the
 * limit its own code set. The code model reads a commit's Java once per run, however many groups and logs ask.
 *
 * One answer per (repo, pinned commit, log commit, files, CAN IDs) is kept (in the browser, or a cache file for the scripts), so
 * a folder of 50 logs that ran 13 commits reads .git 13 times, and the next visit not at all.
 */
import type { Match } from '../match/match.ts'
import { agreedLimits, currentSettings } from '../builder/code-draft.ts'
import { hintsAt, type CodeHints } from '../builder/code-hints.ts'
import type { CurrentLimits, MotorGroup } from '../profiles/types.ts'
import { CommitMissing, GitUnreadable, TryAgain } from './git.ts'
import { filesNamed, type CodeSource, type Kept } from './source.ts'

/** What the log's own commit sets for a group: its limits (read from the code), or why they can't be read. */
export type RanLimits = { commit: string; limits: CurrentLimits } | { why: string }

/** What comparing two commits' lines says; a `different` one gets `ran` before it is kept (`LimitLines`). */
type Comparison =
  /** Same CurrentLimit lines in every limit file of the group. */
  | { verdict: 'same'; files: string[] }
  /** Some differ: each differing line, "- " at the pinned commit only, "+ " in the log's commit only. */
  | { verdict: 'different'; files: string[]; lines: string[] }
  /** Couldn't compare, and why. Never kept: choosing a fuller clone may answer it. `tryAgain`: GitHub couldn't answer now. */
  | { verdict: 'unknown'; why: string; tryAgain?: true }

export type LimitLines = Exclude<Comparison, { verdict: 'different' }> | (Extract<Comparison, { verdict: 'different' }> & { ran: RanLimits })

/** Kept answers, by `limitLinesKey`. */
export type LimitLinesCache = Kept<LimitLines>

/** The robot code to compare against (a folder's .git, or GitHub), and the answers kept from earlier comparisons. */
export interface CodeFolder {
  repo: CodeSource
  cache: LimitLinesCache
  /** Loads the Java reader the code model needs (the page's and node's differ: browser-java.ts, node-java.ts). */
  loadJava: () => Promise<void>
}

/** The lines `git diff -G'CurrentLimit'` looks at. */
const LIMIT_LINE = /CurrentLimit/
/** A file a `where` names: "SpindexerSubsystem.java:123-128" → SpindexerSubsystem.java. */
const FILE_NAME = /[\w$-]+\.(?:java|kt)\b/g

/** The limit files a group's `where` names. */
export function limitFiles(group: MotorGroup): string[] {
  return [...new Set(group.limits.where.match(FILE_NAME) ?? [])]
}

/** Did this log run the commit its profile was copied from? Then there is nothing to compare. */
export function ranPinnedCommit(match: Match): boolean {
  return match.build.sha.startsWith(match.profile.code.sha)
}

/** One kept answer's key. `v2`: answers kept before `ran` existed have no limits for the log's commit, so aren't reused. */
export function limitLinesKey(repo: string, pin: string, logSha: string, files: string[], canIds: (number | undefined)[] = []): string {
  return ['v2', repo, pin, logSha.toLowerCase(), [...files].sort().join(','), canIds.join(',')].join('|')
}

/**
 * Compares each motor group's limit lines for a match that ran another commit than the profile's, and puts the
 * answers on the match (`match.limitLines`, by group name) for power/limit-not-applied to read.
 */
export async function compareMatchLimits(match: Match, code: CodeFolder): Promise<void> {
  if (ranPinnedCommit(match)) return
  const pin = match.profile.code
  // A profile read from a public log pins no commit ('unknown'): nothing to compare against, and nothing to ask.
  const pinned = /^[0-9a-f]{7,40}$/i.test(pin.sha)
  const logSha = match.build.sha.trim()
  const answers = new Map<string, LimitLines>()
  for (const group of match.profile.motorGroups) {
    const files = limitFiles(group)
    if (files.length === 0) continue
    const key = limitLinesKey(pin.repo, pin.sha, logSha, files, group.motors.map((m) => m.canId))
    let answer = pinned ? code.cache.get(key) : { verdict: 'unknown' as const, why: 'the robot profile pins no commit to compare with' }
    if (!answer) {
      const compared = await compareLimitLines(code.repo, pin.sha, logSha, files, pin.repo)
      answer = compared.verdict === 'different' ? await withRanLimits(compared, code, logSha, group) : compared
      if (answer.verdict !== 'unknown') code.cache.set(key, answer)
    }
    answers.set(group.name, answer)
  }
  match.limitLines = answers
}

/** The limits the group's motors get in the code at the log's commit. Hints from GitHub that can't be had now are asked again, not kept. */
async function withRanLimits(answer: Extract<Comparison, { verdict: 'different' }>, code: CodeFolder, logSha: string, group: MotorGroup): Promise<LimitLines> {
  try {
    await code.loadJava()
    const commit = await code.repo.resolve(logSha)
    return { ...answer, ran: ranLimits(await hintsAtCommit(code.repo, commit), commit, group) }
  } catch (error) {
    if (error instanceof TryAgain) return { verdict: 'unknown', why: error.message, tryAgain: true }
    if (error instanceof GitUnreadable) return { ...answer, ran: { why: error.message } }
    return { ...answer, ran: { why: `the code at ${logSha.slice(0, 7)} couldn't be read (${error instanceof Error ? error.message : error})` } }
  }
}

/** Every group of a run asks for the same commit's code model: build it once per (source, commit). */
const hintsKept = new WeakMap<CodeSource, Map<string, Promise<CodeHints>>>()
function hintsAtCommit(repo: CodeSource, commit: string): Promise<CodeHints> {
  const byCommit = hintsKept.get(repo) ?? new Map<string, Promise<CodeHints>>()
  hintsKept.set(repo, byCommit)
  let hints = byCommit.get(commit)
  if (!hints) {
    hints = hintsAt(repo, commit)
    byCommit.set(commit, hints)
    // A failure isn't kept: the next ask tries again.
    hints.catch(() => byCommit.delete(commit))
  }
  return hints
}

/** The limits the code sets on every motor of the group (matched by CAN ID), when they agree. */
function ranLimits(hints: CodeHints, commit: string, group: MotorGroup): RanLimits {
  const unnumbered = group.motors.find((m) => m.canId === undefined)
  if (unnumbered) return { why: `the profile gives no CAN ID for ${unnumbered.name}` }
  const limits = agreedLimits(group.motors.map((m) => currentSettings(hints, m.canId!)))
  return typeof limits === 'string' ? { why: limits } : { commit, limits }
}

/** The CurrentLimit lines of some files at two commits: the same, different (and which lines), or why it can't tell. */
export async function compareLimitLines(repo: CodeSource, pin: string, logSha: string, files: string[], repoName = 'the profile\'s repo'): Promise<Comparison> {
  if (!logSha) return { verdict: 'unknown', why: 'this log has no /RealMetadata/GitSHA' }
  try {
    // The profile's own commit missing usually means another repo's folder was chosen.
    const pinned = await repo.resolve(pin).catch((error) => {
      throw error instanceof CommitMissing ? new GitUnreadable(`the profile's commit ${pin} isn't in ${repo.where}: is it a clone of ${repoName}?`) : error
    })
    const ran = await repo.resolve(logSha)
    const lines: string[] = []
    for (const name of files) lines.push(...(await differingLines(repo, pinned, ran, name)))
    return lines.length ? { verdict: 'different', files, lines } : { verdict: 'same', files }
  } catch (error) {
    if (error instanceof TryAgain) return { verdict: 'unknown', why: error.message, tryAgain: true }
    if (error instanceof GitUnreadable) return { verdict: 'unknown', why: error.message }
    return { verdict: 'unknown', why: `the code folder's .git couldn't be read (${error instanceof Error ? error.message : error})` }
  }
}

/** One file's CurrentLimit lines that differ between the two commits ("- " pinned only, "+ " log's only). */
async function differingLines(repo: CodeSource, pinned: string, ran: string, name: string): Promise<string[]> {
  const before = await onlyFileNamed(repo, pinned, name)
  if (!before) throw new GitUnreadable(`${name} isn't in commit ${pinned.slice(0, 7)} (the profile's commit)`)
  const after = await onlyFileNamed(repo, ran, name)
  if (after?.sha === before.sha) return []
  const was = limitLinesOf(await repo.textAt(pinned, before.path))
  const now = after ? limitLinesOf(await repo.textAt(ran, after.path)) : []
  if (was.join('\n') === now.join('\n')) return []
  const removed = linesNotIn(was, now).map((line) => `- ${name}: ${line}`)
  const added = linesNotIn(now, was).map((line) => `+ ${name}: ${line}`)
  // The same lines in another order still differ (a line may now set another motor's config).
  return removed.length || added.length ? [...removed, ...added] : [`${name}: the same lines in another order`]
}

/** The one file with this name in a commit, or null if there is none. Two or more: it can't tell which. */
async function onlyFileNamed(repo: CodeSource, commit: string, name: string) {
  const found = await filesNamed(repo, commit, name)
  if (found.length > 1) throw new GitUnreadable(`commit ${commit.slice(0, 7)} has ${found.length} files named ${name}`)
  return found[0] ?? null
}

/** The lines of `a` that `b` lacks, counting repeats: the indexer's and kicker's identical lines are two lines. */
function linesNotIn(a: string[], b: string[]): string[] {
  const left = new Map<string, number>()
  for (const line of b) left.set(line, (left.get(line) ?? 0) + 1)
  return a.filter((line) => {
    const n = left.get(line) ?? 0
    left.set(line, n - 1)
    return n <= 0
  })
}

function limitLinesOf(text: string): string[] {
  return text.split('\n').filter((line) => LIMIT_LINE.test(line)).map((line) => line.trim())
}
