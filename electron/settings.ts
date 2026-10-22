/** This machine's own settings (never shared): the machine id, where the library is, which team folder. */
import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from '../src/hub/library-store.ts'

export interface Settings {
  /** Minted once per install; names this machine's manifest. */
  machineId: string
  libraryDir: string
}

const file = () => join(app.getPath('userData'), 'settings.json')

export async function loadSettings(): Promise<Settings> {
  const saved = await readJson<Partial<Settings>>(file(), {})
  const settings: Settings = {
    machineId: saved.machineId ?? `m${randomBytes(6).toString('hex')}`,
    libraryDir: saved.libraryDir ?? join(app.getPath('userData'), 'library'),
  }
  if (saved.machineId !== settings.machineId || saved.libraryDir !== settings.libraryDir) await writeJson(file(), settings)
  return settings
}
