/**
 * What changed, from the `Changelog:` commit trailers (docs/release.md), for the card Now shows after an update. Baked into
 * the build, so it works with no internet in the pit. A release is v0.1.<commits on main>, and a line belongs to the
 * commit that brought it onto main: a branch's commit counts fewer commits than the release it landed in.
 */
export interface ChangelogEntry { version: number; lines: string[] }

declare const __CHANGELOG__: ChangelogEntry[]
/** The changelog this build was made with (vite.changelog.ts). */
export const builtChangelog = (): ChangelogEntry[] => (typeof __CHANGELOG__ === 'undefined' ? [] : __CHANGELOG__)

export const LOG_FORMAT = '%H %P%x1f%(trailers:key=Changelog,valueonly,unfold)%x1e'

/** Entries from `git log --format=LOG_FORMAT`, oldest first. */
export function changelogEntries(gitLog: string, head: string): ChangelogEntry[] {
  const commits = new Map(gitLog.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => {
    const [ids, trailers = ''] = c.split('\x1f')
    const [sha, ...parents] = ids.trim().split(' ')
    return [sha, { parents, lines: trailers.split('\n').map((l) => l.trim()).filter(Boolean) }] as const
  }))
  const onMain: string[] = []
  for (let sha: string | undefined = head; sha && commits.has(sha); sha = commits.get(sha)!.parents[0]) onMain.unshift(sha)
  const seen = new Set<string>()
  const entries: ChangelogEntry[] = []
  for (const tip of onMain) {
    const lines: string[] = []
    for (const stack = [tip]; stack.length;) {
      const sha = stack.pop()!
      const commit = commits.get(sha)
      if (!commit || seen.has(sha)) continue
      seen.add(sha)
      lines.push(...commit.lines)
      stack.push(...commit.parents)
    }
    if (lines.length) entries.push({ version: seen.size, lines: [...new Set(lines)] })
  }
  return entries
}

const patch = (version: string | null) => /^0\.1\.(\d+)$/.exec(version ?? '')?.[1]

/**
 * The lines to show, newest release first: what landed after the version last seen, up to the one running. With none
 * seen, a fresh install has nothing to catch up on; a copy that already holds logs updated from before this card existed,
 * so it gets the newest release's lines.
 */
export function whatsNew(entries: ChangelogEntry[], running: string, seen: string | null, hasLogs: boolean): string[] {
  const now = Number(patch(running))
  if (!now) return []
  const from = patch(seen)
  const newest = entries.filter((e) => e.version <= now).at(-1)
  const since = from !== undefined ? entries.filter((e) => e.version > Number(from) && e.version <= now) : hasLogs && newest ? [newest] : []
  return [...new Set([...since].reverse().flatMap((e) => e.lines))]
}
