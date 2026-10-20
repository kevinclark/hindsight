/**
 * A robot-code folder for the Node scripts (golden, report.ts, tests): its .git, and the kept limit-line answers in a
 * cache file. The page uses src/code/browser-code-folder.ts. Follows a `.git` file (a worktree or submodule) to the
 * folder holding the objects. `nodeGitHub` is the same with the code read from GitHub, its file lists kept in the same
 * cache file.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GitRepo, type GitDir } from './git.ts'
import { GitHubRepo } from './github.ts'
import type { CodeFolder, LimitLines } from './limit-lines.ts'
import type { CodeFileEntry, CodeSource, Kept } from './source.ts'

/** Where the scripts keep limit-line answers between runs, unless told otherwise. */
export const DEFAULT_CACHE = join(homedir(), '.cache', 'hindsight', 'limit-lines.json')

/**
 * The code folder for analyzeFilesWithCode, with answers kept in `cacheFile`; call `save()` after the run. Throws when
 * the folder has no .git: a script told to use a code folder shouldn't quietly run without one.
 */
export function nodeCodeFolder(folder: string, cacheFile = DEFAULT_CACHE): CodeFolder & { save(): void } {
  const dir = nodeGitDir(folder)
  if (!dir) throw new Error(`${folder} has no .git folder`)
  return withCacheFile(cacheFile, () => new GitRepo(dir))
}

/** The same, reading the public GitHub repo `repo` ("owner/name"). `repo.calls` counts what it asked GitHub. */
export function nodeGitHub(repo: string, cacheFile = DEFAULT_CACHE): CodeFolder & { save(): void; repo: GitHubRepo } {
  return withCacheFile(cacheFile, (github) => new GitHubRepo(repo, github))
}

/** A code source with the cache file's kept answers (and GitHub file lists); `save()` writes them back if they changed. */
function withCacheFile<S extends CodeSource>(cacheFile: string, source: (github: Kept<CodeFileEntry[] | string>) => S): { repo: S; cache: Kept<LimitLines>; save(): void } {
  let kept: { answers: Record<string, LimitLines>; github: Record<string, CodeFileEntry[] | string> } = { answers: {}, github: {} }
  try {
    const file = JSON.parse(readFileSync(cacheFile, 'utf8'))
    kept = { answers: file.answers ?? {}, github: file.github ?? {} }
  } catch {
    // No cache file yet, or an unreadable one: start empty.
  }
  let changed = false
  const keep = <T>(store: Record<string, T>): Kept<T> => ({
    get: (key) => store[key],
    set: (key, value) => { store[key] = value; changed = true },
  })
  return {
    repo: source(keep(kept.github)),
    cache: keep(kept.answers),
    save() {
      if (!changed) return
      mkdirSync(dirname(cacheFile), { recursive: true })
      // GitHub's file lists only when there are some, so a folder-only cache file reads as before.
      writeFileSync(cacheFile, JSON.stringify({ version: 1, answers: kept.answers, ...(Object.keys(kept.github).length ? { github: kept.github } : {}) }, null, 1))
    },
  }
}

/** The .git of a code folder (or the .git folder itself), or null if it has none. */
export function nodeGitDir(folder: string): GitDir | null {
  const root = gitFolder(folder)
  if (!root) return null
  return {
    async read(path, start, end) {
      const file = join(root, path)
      if (!existsSync(file) || !statSync(file).isFile()) return null
      if (start === undefined) return new Uint8Array(readFileSync(file))
      const fd = openSync(file, 'r')
      try {
        const length = Math.max(0, Math.min(end ?? Infinity, statSync(file).size) - start)
        const bytes = new Uint8Array(length)
        readSync(fd, bytes, 0, length, start)
        return bytes
      } finally {
        closeSync(fd)
      }
    },
    async size(path) {
      const file = join(root, path)
      return existsSync(file) && statSync(file).isFile() ? statSync(file).size : null
    },
    async list(path) {
      const dir = join(root, path)
      return existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : []
    },
  }
}

function gitFolder(folder: string): string | null {
  const dotGit = existsSync(join(folder, 'objects')) && existsSync(join(folder, 'HEAD')) ? folder : join(folder, '.git')
  if (!existsSync(dotGit)) return null
  if (statSync(dotGit).isDirectory()) return commonDir(dotGit)
  const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
  return target ? commonDir(resolve(folder, target)) : null
}

/** A worktree's git folder names the shared one (where the objects are) in `commondir`. */
function commonDir(dir: string): string {
  const file = join(dir, 'commondir')
  return existsSync(file) ? resolve(dir, readFileSync(file, 'utf8').trim()) : dir
}
