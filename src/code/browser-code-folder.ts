/**
 * The robot-code folder in the browser: its .git read from a chosen folder, either a folder handle (Chrome and Edge,
 * `showDirectoryPicker`, which this browser can remember) or the files of a folder input (any browser, forgotten on
 * reload). Nothing is changed or uploaded; only the .git files needed are read, a slice at a time. Or, instead of a
 * folder, a public GitHub repo (src/code/github.ts).
 *
 * Limit-line answers, GitHub's file lists and the GitHub repo chosen are kept in localStorage, and the folder handle in
 * IndexedDB. Every storage call is wrapped: a private window or blocked storage just means nothing is remembered.
 */
import { GitRepo, GitUnreadable, type GitDir } from './git.ts'
import { GitHubRepo } from './github.ts'
import type { CodeFolder, LimitLines } from './limit-lines.ts'
import type { CodeFileEntry, Kept } from './source.ts'

const ANSWERS = 'hindsight.limitLines'
const GITHUB_FILES = 'hindsight.githubFiles'
const GITHUB_CHOSEN = 'hindsight.codeGitHub'
/** GitHub file lists (about 10 KB each) and short hashes kept: the oldest go first, well inside localStorage's 5 MB. */
const KEEP_GITHUB = 100
const DB = 'hindsight-code'
const STORE = 'folders'

/** A chosen folder: what to call it, and its .git (null when the folder has none, with the reason). */
export interface ChosenFolder { name: string; code: CodeFolder | null; problem: string | null }

/** The folder input's files (webkitdirectory): paths like "Rebuilt/.git/objects/pack/pack-1.idx". */
export function folderFromFiles(files: File[]): ChosenFolder {
  const name = files[0]?.webkitRelativePath.split('/')[0] || 'the folder'
  const repo = gitRepoOfFiles(files)
  if (!repo) return { name, code: null, problem: noGit(name, files.some((f) => /^[^/]+\/\.git$/.test(f.webkitRelativePath))) }
  return { name, code: { repo, cache: browserKept<LimitLines>(ANSWERS) }, problem: null }
}

/** The .git among a folder input's files, or null when the folder has none. */
export function gitRepoOfFiles(files: File[]): GitRepo | null {
  const inGit = new Map<string, File>()
  for (const f of files) {
    const at = f.webkitRelativePath.indexOf('/.git/')
    if (at >= 0 && f.webkitRelativePath.lastIndexOf('/', at - 1) < 0) inGit.set(f.webkitRelativePath.slice(at + 6), f)
  }
  if (inGit.size === 0) return null
  return new GitRepo({
    read: async (path, start, end) => {
      const f = inGit.get(path)
      return f ? new Uint8Array(await (start === undefined ? f : f.slice(start, end)).arrayBuffer()) : null
    },
    size: async (path) => inGit.get(path)?.size ?? null,
    list: async (path) => [...inGit.keys()].filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')).map((p) => p.slice(path.length + 1)),
  })
}

/** A folder handle (showDirectoryPicker). */
export async function folderFromHandle(handle: FileSystemDirectoryHandle): Promise<ChosenFolder> {
  let git: FileSystemDirectoryHandle
  try {
    git = await handle.getDirectoryHandle('.git')
  } catch {
    const isFile = await handle.getFileHandle('.git').then(() => true, () => false)
    return { name: handle.name, code: null, problem: noGit(handle.name, isFile) }
  }
  const folder = async (path: string) => {
    let at = git
    for (const part of path.split('/').filter(Boolean)) at = await at.getDirectoryHandle(part)
    return at
  }
  const file = async (path: string) => {
    const parts = path.split('/')
    const name = parts.pop() as string
    try {
      return await (await (await folder(parts.join('/'))).getFileHandle(name)).getFile()
    } catch (error) {
      onlyIfMissing(error)
      return null
    }
  }
  /** A file or folder that isn't there is fine; any other error (no longer allowed to read) is said as such. */
  const onlyIfMissing = (error: unknown) => {
    if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return
    throw new GitUnreadable(`this browser no longer allows reading ${handle.name}: choose the code folder again`)
  }
  const dir: GitDir = {
    read: async (path, start, end) => {
      const f = await file(path)
      return f ? new Uint8Array(await (start === undefined ? f : f.slice(start, end)).arrayBuffer()) : null
    },
    size: async (path) => (await file(path))?.size ?? null,
    list: async (path) => {
      try {
        const names: string[] = []
        for await (const name of (await folder(path)).keys()) names.push(name)
        return names
      } catch (error) {
        onlyIfMissing(error)
        return []
      }
    },
  }
  return { name: handle.name, code: { repo: new GitRepo(dir), cache: browserKept<LimitLines>(ANSWERS) }, problem: null }
}

/** A public GitHub repo ("owner/name"). Its name says GitHub, so a log read with a folder of the same name isn't
 * taken for one read with this; it leaves out the branch, which the comparison never reads. */
export function githubSource(repo: string): ChosenFolder {
  return { name: `${repo} (GitHub)`, code: { repo: browserGitHub(repo), cache: browserKept<LimitLines>(ANSWERS) }, problem: null }
}

/** A GitHub repo whose file lists are kept in this browser (the newest KEEP_GITHUB of them). */
export function browserGitHub(repo: string): GitHubRepo {
  return new GitHubRepo(repo, browserKept<CodeFileEntry[] | string>(GITHUB_FILES, KEEP_GITHUB))
}

/** The GitHub repo and ref chosen last visit ("owner/name@ref"), or null. Choosing a folder forgets it. */
export function rememberedGitHub(): string | null {
  try {
    return localStorage.getItem(GITHUB_CHOSEN)
  } catch {
    return null
  }
}

export function rememberGitHub(spec: string | null): void {
  try {
    if (spec) localStorage.setItem(GITHUB_CHOSEN, spec)
    else localStorage.removeItem(GITHUB_CHOSEN)
  } catch {
    // Not remembered: a private window.
  }
}

function noGit(name: string, gitIsFile: boolean): string {
  return gitIsFile
    ? `${name}'s .git is a file pointing elsewhere (a git worktree or submodule): choose the main clone of the robot code instead.`
    : `${name} has no .git folder: choose the folder you cloned the robot code into (the one holding .git).`
}

/** Can this browser pick a folder it can remember (Chrome, Edge), or only read one for this visit? */
export const canRemember = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window

/** Ask for a folder through showDirectoryPicker, and remember its handle. Null if the person cancelled. */
export async function pickFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const handle = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'robot-code', mode: 'read' })
    await storeHandle(handle)
    return handle
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
}

/** The handle remembered last visit, and whether reading it still needs the person's OK (a click). */
export async function rememberedFolder(): Promise<{ handle: FileSystemDirectoryHandle; needsPermission: boolean } | null> {
  const handle = await withStore<FileSystemDirectoryHandle>('readonly', (s) => s.get('robot-code'))
  if (!handle) return null
  try {
    const state = await (handle as unknown as { queryPermission(o: object): Promise<PermissionState> }).queryPermission({ mode: 'read' })
    return { handle, needsPermission: state !== 'granted' }
  } catch {
    return { handle, needsPermission: true }
  }
}

/** Ask again for the remembered folder (must run from a click). */
export async function allowFolder(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    return (await (handle as unknown as { requestPermission(o: object): Promise<PermissionState> }).requestPermission({ mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}

export async function forgetFolder(): Promise<void> {
  await withStore('readwrite', (s) => s.delete('robot-code'))
}

const storeHandle = (handle: FileSystemDirectoryHandle) => withStore('readwrite', (s) => s.put(handle, 'robot-code'))

function withStore<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
      req.onsuccess = () => {
        const db = req.result
        try {
          const tx = db.transaction(STORE, mode)
          const r = body(tx.objectStore(STORE))
          tx.oncomplete = () => { db.close(); resolve((r.result as T) ?? null) }
          tx.onerror = () => { db.close(); resolve(null) }
          tx.onabort = () => { db.close(); resolve(null) }
        } catch {
          db.close()
          resolve(null)
        }
      }
    } catch {
      resolve(null)
    }
  })
}

/** Answers kept in this browser's localStorage under one key: limit-line answers, GitHub's file lists (`atMost`). */
function browserKept<T>(storageKey: string, atMost = Infinity): Kept<T> {
  const read = (): Record<string, T> => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    } catch {
      return {}
    }
  }
  return {
    get: (key) => read()[key],
    set: (key, value) => {
      try {
        const entries = Object.entries(read()).filter(([k]) => k !== key)
        localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries([...entries.slice(-(atMost - 1)), [key, value]])))
      } catch {
        // Not remembered: a private window, storage blocked for pages opened from disk, or full.
      }
    },
  }
}
