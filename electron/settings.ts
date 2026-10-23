/** This machine's own settings (never shared): the machine id, where the library is, which team folder. */
import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readJson, writeJson } from '../src/hub/library-store.ts'

export interface Settings {
  /** Minted once per install; names this machine's manifest. */
  machineId: string
  libraryDir: string
  /** The team's Drive folder, chosen at run time and remembered here (never in the repo). */
  teamFolder?: { id: string; name: string }
  /** A Google Desktop OAuth client a team made for itself, used in place of the build's. */
  googleClient?: { id: string; secret: string }
  /** The team's FRC number (1-99999): the robot lists show this team's robots (src/ui/robot-list.ts). */
  team?: number
  /** GitHub orgs ("name") or repos ("owner/name") whose code logs are linked to (src/hub/codelink.ts). Chosen at run time, never in the repo. */
  codeSources?: string[]
  /** The last sync: when, and the paths the team store held (what "shared" means in the Library view). */
  lastSync?: { at: number; paths: string[] }
}

const file = () => join(app.getPath('userData'), 'settings.json')

export async function loadSettings(): Promise<Settings> {
  const saved = await readJson<Partial<Settings>>(file(), {})
  const settings: Settings = { ...saved, machineId: saved.machineId ?? `m${randomBytes(6).toString('hex')}`, libraryDir: saved.libraryDir ?? join(app.getPath('userData'), 'library') }
  if (saved.machineId !== settings.machineId || saved.libraryDir !== settings.libraryDir) await writeJson(file(), settings)
  return settings
}

export async function saveSettings(change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...change }
  await writeJson(file(), next)
  return next
}
