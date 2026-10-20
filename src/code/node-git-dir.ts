/**
 * A robot-code folder for the Node scripts (golden, report.ts, tests): its .git, and the kept limit-line answers in a
 * cache file. The page uses src/code/browser-code-folder.ts. Follows a `.git` file (a worktree or submodule) to the
 * folder holding the objects.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GitRepo, type GitDir } from './git.ts'
import type { CodeFolder, LimitLines } from './limit-lines.ts'

/** Where the scripts keep limit-line answers between runs, unless told otherwise. */
export const DEFAULT_CACHE = join(homedir(), '.cache', 'hindsight', 'limit-lines.json')

/**
 * The code folder for analyzeFilesWithCode, with answers kept in `cacheFile`; call `save()` after the run. Throws when
 * the folder has no .git: a script told to use a code folder shouldn't quietly run without one.
 */
export function nodeCodeFolder(folder: string, cacheFile = DEFAULT_CACHE): CodeFolder & { save(): void } {
  const dir = nodeGitDir(folder)
  if (!dir) throw new Error(`${folder} has no .git folder`)
  let answers: Record<string, LimitLines> = {}
  try {
    answers = JSON.parse(readFileSync(cacheFile, 'utf8')).answers ?? {}
  } catch {
    // No cache file yet, or an unreadable one: start empty.
  }
  let changed = false
  return {
    repo: new GitRepo(dir),
    cache: {
      get: (key) => answers[key],
      set: (key, answer) => { answers[key] = answer; changed = true },
    },
    save() {
      if (!changed) return
      mkdirSync(dirname(cacheFile), { recursive: true })
      writeFileSync(cacheFile, JSON.stringify({ version: 1, answers }, null, 1))
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
