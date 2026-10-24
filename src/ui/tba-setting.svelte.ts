/**
 * What the event lookup (src/tba/) needs: the team number and a The Blue Alliance read key, kept per laptop. In the
 * desktop app both live in its settings (the key stays in the main process: the page is only told whether one is set,
 * and asks the app for each read). In the single-file page they live in localStorage, guarded like App.svelte's.
 */
import { hub } from '../hub/bridge.ts'
import { createTba, localStorageStore, type TbaGet } from '../tba/source.ts'
import { setTeamNow, teamNow } from './team-setting.svelte.ts'

const TEAM = 'hindsight.tba.team'
const KEY = 'hindsight.tba.key'
const read = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }

let pageTeam = $state<number | null>(Number(read(TEAM)) || null)
let pageKey = $state<string | null>(read(KEY))
let appKey = $state(false)

export const tbaTeam = (): number | null => (hub() ? teamNow() : pageTeam)
export const tbaHasKey = (): boolean => (hub() ? appKey : !!pageKey)
export const setAppHasKey = (has: boolean) => { appKey = has }

/** The desktop app: whether a key is saved. */
export async function loadTba(): Promise<void> {
  try { appKey = !!(await hub()?.team())?.tbaKey } catch { appKey = false }
}

/** The page's own two fields. An empty key clears it. */
export function savePageTba(team: number | null, key: string): void {
  pageTeam = team
  if (key.trim()) pageKey = key.trim(); else if (key === '') pageKey = null
  try {
    if (team) localStorage.setItem(TEAM, String(team)); else localStorage.removeItem(TEAM)
    if (pageKey) localStorage.setItem(KEY, pageKey); else localStorage.removeItem(KEY)
  } catch { /* private window: lasts until the page closes */ }
}

/** What is missing for the lookup, in words; null when it can run. */
export function tbaMissing(): string | null {
  const need = [tbaTeam() === null ? 'a team number' : '', tbaHasKey() ? '' : 'a The Blue Alliance read key'].filter(Boolean)
  return need.length ? `Event names from The Blue Alliance need ${need.join(' and ')}.` : null
}

/** A reader of The Blue Alliance for the lookup, or null when it cannot run. */
export function tbaGetter(): TbaGet | null {
  if (tbaTeam() === null || !tbaHasKey()) return null
  const app = hub()
  if (app) return (path, opts) => app.tba(path, opts)
  return createTba({ key: pageKey!, store: localStorageStore() })
}

/** Bumped after each `saveSetup`, so a form that keeps its own copy of the settings (the Library's) reads them again instead of saving a stale one over a newer save. */
let savedVersion = $state(0)
export const setupSaves = (): number => savedVersion

/** What a setup field can change; a missing part is left as it is (a blank key never clears the saved one). */
export interface SetupPatch { team?: number | null; key?: string; sources?: string[] }

/**
 * Save from a field that sits beside the thing it unlocks (the board's next-match fields, the setup card). The desktop app
 * goes through the same call the Library's "Your team" Save uses, keeping the saved GitHub sources; the page uses the
 * same store as `TbaFields`. Returns words for a refusal, or null. The key is never echoed.
 */
export async function saveSetup(patch: SetupPatch): Promise<string | null> {
  const app = hub()
  const key = patch.key?.trim() ?? ''
  if (app) {
    try {
      const now = await app.team()
      const saved = await app.setTeam(patch.team !== undefined ? patch.team : now.team, patch.sources ?? now.sources, key || undefined)
      setTeamNow(saved.team)
      setAppHasKey(!!saved.tbaKey)
      savedVersion++
      return null
    } catch (e) { return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : 'Could not save.' }
  }
  const team = patch.team !== undefined ? patch.team : pageTeam
  if (team !== null && (!Number.isInteger(team) || team < 1 || team > 99999)) return 'A team number is a whole number from 1 to 99999.'
  if (key && !/^[A-Za-z0-9_-]{16,128}$/.test(key)) return 'That does not look like a The Blue Alliance read key: it is letters, numbers, - and _ only (account page, Read API Keys).'
  // `savePageTba` clears the key on an empty string; a field that left it blank means "leave it".
  savePageTba(team, key || (pageKey ?? ''))
  savedVersion++
  return null
}
