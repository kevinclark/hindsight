/**
 * Did the log run the same current limits as the commit the robot profile was copied from? The profile pins one
 * commit (`profile.code.sha`), but a robot runs many commits in a day, most of them with the limits untouched. With the
 * robot-code folder at hand, this reads each motor group's limit files (named in its `limits.where`) at both commits
 * straight from .git and compares the lines that mention CurrentLimit, as `git diff -G'CurrentLimit'` would: lines,
 * never parsed values.
 *
 * One answer per (repo, pinned commit, log commit, files) is kept (in the browser, or a cache file for the scripts), so
 * a folder of 50 logs that ran 13 commits reads .git 13 times, and the next visit not at all.
 */
import type { Match } from '../match/match.ts'
import type { MotorGroup } from '../profiles/types.ts'
import { GitRepo, GitUnreadable } from './git.ts'

export type LimitLines =
  /** Same CurrentLimit lines in every limit file of the group. */
  | { verdict: 'same'; files: string[] }
  /** Some differ: each differing line, "- " at the pinned commit only, "+ " in the log's commit only. */
  | { verdict: 'different'; files: string[]; lines: string[] }
  /** Couldn't compare, and why. Never kept: choosing a fuller clone may answer it. */
  | { verdict: 'unknown'; why: string }

/** Kept answers, by `limitLinesKey`. */
export interface LimitLinesCache {
  get(key: string): LimitLines | undefined
  set(key: string, answer: LimitLines): void
}

/** A robot-code folder's .git to compare against, and the answers kept from earlier comparisons. */
export interface CodeFolder {
  repo: GitRepo
  cache: LimitLinesCache
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

export function limitLinesKey(repo: string, pin: string, logSha: string, files: string[]): string {
  return [repo, pin, logSha.toLowerCase(), [...files].sort().join(',')].join('|')
}

/**
 * Compares each motor group's limit lines for a match that ran another commit than the profile's, and puts the
 * answers on the match (`match.limitLines`, by group name) for power/limit-not-applied to read.
 */
export async function compareMatchLimits(match: Match, code: CodeFolder): Promise<void> {
  if (ranPinnedCommit(match)) return
  const pin = match.profile.code
  const logSha = match.build.sha.trim()
  const answers = new Map<string, LimitLines>()
  for (const group of match.profile.motorGroups) {
    const files = limitFiles(group)
    if (files.length === 0) continue
    const key = limitLinesKey(pin.repo, pin.sha, logSha, files)
    let answer = code.cache.get(key)
    if (!answer) {
      answer = await compareLimitLines(code.repo, pin.sha, logSha, files, pin.repo)
      if (answer.verdict !== 'unknown') code.cache.set(key, answer)
    }
    answers.set(group.name, answer)
  }
  match.limitLines = answers
}

/** The CurrentLimit lines of some files at two commits: the same, different (and which lines), or why it can't tell. */
export async function compareLimitLines(repo: GitRepo, pin: string, logSha: string, files: string[], repoName = 'the profile\'s repo'): Promise<LimitLines> {
  if (!logSha) return { verdict: 'unknown', why: 'this log has no /RealMetadata/GitSHA' }
  try {
    // The profile's own commit missing usually means another repo's folder was chosen.
    const pinned = await repo.resolve(pin).catch((error) => {
      throw error instanceof GitUnreadable ? new GitUnreadable(`the profile's commit ${pin} isn't in this code folder: is it a clone of ${repoName}?`) : error
    })
    const ran = await repo.resolve(logSha)
    const lines: string[] = []
    for (const name of files) lines.push(...(await differingLines(repo, pinned, ran, name)))
    return lines.length ? { verdict: 'different', files, lines } : { verdict: 'same', files }
  } catch (error) {
    if (error instanceof GitUnreadable) return { verdict: 'unknown', why: error.message }
    return { verdict: 'unknown', why: `the code folder's .git couldn't be read (${error instanceof Error ? error.message : error})` }
  }
}

/** One file's CurrentLimit lines that differ between the two commits ("- " pinned only, "+ " log's only). */
async function differingLines(repo: GitRepo, pinned: string, ran: string, name: string): Promise<string[]> {
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
async function onlyFileNamed(repo: GitRepo, commit: string, name: string) {
  const found = await repo.filesNamed(commit, name)
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
