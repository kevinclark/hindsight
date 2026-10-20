/**
 * Robot code at a commit, wherever its bytes come from: a robot-code folder's .git (`GitRepo`, git.ts) or a public
 * GitHub repo (`GitHubRepo`, github.ts). The limit-line comparison and the profile builder's CAN ID hints read code
 * only through this, so they work the same from either.
 *
 * Every method throws `GitUnreadable` (git.ts) with a reason a person can act on when it can't answer.
 */

/** A file in a commit: its path from the top of the repo, and its blob hash. */
export interface CodeFileEntry { path: string; sha: string }

export interface CodeSource {
  /** Where the code is, for messages: "this code folder", "HighlanderRobotics/Rebuilt on GitHub". */
  readonly where: string
  /** The full commit hash a hash or prefix (7+ hex characters) names; GitHub also takes a branch name. */
  resolve(ref: string): Promise<string>
  /** Every file in a commit (submodules left out). */
  files(commit: string): Promise<CodeFileEntry[]>
  /** A file's text at a commit, by its path from the top of the repo. */
  textAt(commit: string, path: string): Promise<string>
}

/** Every file in a commit with this file name (any folder). */
export async function filesNamed(source: CodeSource, commit: string, name: string): Promise<CodeFileEntry[]> {
  return (await source.files(commit)).filter((f) => f.path === name || f.path.endsWith(`/${name}`))
}

/** Answers kept between visits (localStorage in the page, a cache file for the scripts). */
export interface Kept<T> {
  get(key: string): T | undefined
  set(key: string, value: T): void
}
