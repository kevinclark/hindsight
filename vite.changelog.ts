import { execFileSync } from 'node:child_process'
import { changelogEntries, LOG_FORMAT, type ChangelogEntry } from './src/now/changelog.ts'

/** The changelog at this checkout, for the build. Empty with no git history to read. */
export function changelog(): ChangelogEntry[] {
  try {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return changelogEntries(git('log', `--format=${LOG_FORMAT}`), git('rev-parse', 'HEAD').trim())
  } catch { return [] }
}
