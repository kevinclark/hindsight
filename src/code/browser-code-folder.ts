/**
 * The robot-code folder in the browser: its .git read from a chosen folder, either a folder handle (Chrome and Edge,
 * `showDirectoryPicker`, which this browser can remember) or the files of a folder input (any browser, forgotten on
 * reload). Nothing is changed or uploaded; only the .git files needed are read, a slice at a time.
 *
 * Limit-line answers are kept in localStorage, and the folder handle in IndexedDB. Every storage call is wrapped: a
 * private window or blocked storage just means nothing is remembered.
 */
import { GitRepo, GitUnreadable, type GitDir } from './git.ts'
import type { CodeFolder, LimitLines, LimitLinesCache } from './limit-lines.ts'

const ANSWERS = 'hindsight.limitLines'
const DB = 'hindsight-code'
const STORE = 'folders'

/** A chosen folder: what to call it, and its .git (null when the folder has none, with the reason). */
export interface ChosenFolder { name: string; code: CodeFolder | null; problem: string | null }

/** The folder input's files (webkitdirectory): paths like "Rebuilt/.git/objects/pack/pack-1.idx". */
export function folderFromFiles(files: File[]): ChosenFolder {
  const name = files[0]?.webkitRelativePath.split('/')[0] || 'the folder'
  const repo = gitRepoOfFiles(files)
  if (!repo) return { name, code: null, problem: noGit(name, files.some((f) => /^[^/]+\/\.git$/.test(f.webkitRelativePath))) }
  return { name, code: { repo, cache: browserCache() }, problem: null }
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
  return { name: handle.name, code: { repo: new GitRepo(dir), cache: browserCache() }, problem: null }
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

/** Limit-line answers kept in this browser's localStorage. */
function browserCache(): LimitLinesCache {
  const read = (): Record<string, LimitLines> => {
    try {
      return JSON.parse(localStorage.getItem(ANSWERS) ?? '{}')
    } catch {
      return {}
    }
  }
  return {
    get: (key) => read()[key],
    set: (key, answer) => {
      try {
        localStorage.setItem(ANSWERS, JSON.stringify({ ...read(), [key]: answer }))
      } catch {
        // Not remembered: a private window, or storage blocked for pages opened from disk.
      }
    },
  }
}
