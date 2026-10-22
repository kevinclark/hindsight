/** Where the findings' files are on GitHub, for the run's summary and comment. */
import { realpathSync } from 'node:fs'
import { GitUnreadable } from '../git.ts'
import type { CodeSource } from '../source.ts'
import type { Linker } from './github-format.ts'

/**
 * Links go to `linkSha` (a pull request's head), but the check read `commit` (checkout's default is a merge of the head
 * into the base, a different commit). A line number holds at the link only in files with the same text at both, so only
 * those get `#L<line>`; the others link to the file. Without GITHUB_SERVER_URL and GITHUB_REPOSITORY there are no links,
 * and neither when the checked folder is not the run's own repository (GITHUB_WORKSPACE): the files aren't there.
 */
export async function linkerFor(source: CodeSource, folder: string, commit: string, linkSha: string, env: NodeJS.ProcessEnv): Promise<Linker> {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } = env
  if (!server || !repository || !isWorkspace(folder, env.GITHUB_WORKSPACE)) return { blob: null, sameText: new Set() }
  const blob = `${server}/${repository}/blob/${linkSha}`
  if (linkSha === commit) return { blob, sameText: new Set((await source.files(commit)).map((f) => f.path)) }
  try {
    const linked = new Map((await source.files(await source.resolve(linkSha))).map((f) => [f.path, f.sha]))
    const same = (await source.files(commit)).filter((f) => linked.get(f.path) === f.sha)
    return { blob, sameText: new Set(same.map((f) => f.path)) }
  } catch (error) {
    if (!(error instanceof GitUnreadable)) throw error
    return { blob, sameText: new Set() }          // the head wasn't fetched: link to the files, without a line
  }
}

/** True when `folder` is the run's own checkout (GITHUB_WORKSPACE), the only folder whose files are in GITHUB_REPOSITORY. */
function isWorkspace(folder: string, workspace: string | undefined): boolean {
  if (!workspace) return false
  try {
    return realpathSync(folder) === realpathSync(workspace)
  } catch {
    return false
  }
}
