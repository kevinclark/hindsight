/** The Blue Alliance answers, kept in one JSON file in the app's data folder (never in the library, so it is never shared or synced). */
import { app } from 'electron'
import { join } from 'node:path'
import { readJson, writeJson } from '../src/hub/library-store.ts'
import type { TbaStore } from '../src/tba/source.ts'

export function fileTbaStore(): TbaStore {
  const file = () => join(app.getPath('userData'), 'tba-cache.json')
  type Cache = Record<string, { at: number; data: unknown }>
  let loaded: Promise<Cache> | null = null
  let writing: Promise<void> = Promise.resolve()
  const all = () => (loaded ??= readJson<Cache>(file(), {}))
  return {
    async read(path) { return (await all())[path] },
    async write(path, entry) {
      const cache = await all()
      cache[path] = entry
      writing = writing.then(() => writeJson(file(), cache)).catch(() => {})
      await writing
    },
  }
}
