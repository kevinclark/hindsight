/**
 * The "seen" memory (`seen.json`): which files were read before, by their cache key, so a pull or add does not read them
 * again. Saved after each file (atomic: temp + rename), not once at the end: a stall, Stop, crash or quit part way keeps
 * what was done, and the retry starts at the first file not done.
 */
import { readJson, writeJson } from './library-store.ts'

export interface SeenMemory {
  get(key: string): string | undefined
  set(key: string, sha256: string): void
  /** Write it if anything was set since the last write. */
  save(): Promise<void>
}

export async function openSeen(path: string): Promise<SeenMemory> {
  const seen = new Map(Object.entries(await readJson<Record<string, string>>(path, {})))
  let dirty = false
  return {
    get: (key) => seen.get(key),
    set: (key, sha256) => { seen.set(key, sha256); dirty = true },
    save: async () => { if (!dirty) return; dirty = false; try { await writeJson(path, Object.fromEntries(seen)) } catch (e) { dirty = true; throw e } },
  }
}
