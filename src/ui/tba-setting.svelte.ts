/**
 * What the event lookup (src/tba/) needs: the team number and a The Blue Alliance read key, kept per laptop. In the
 * desktop app both live in its settings (the key stays in the main process: the page is only told whether one is set,
 * and asks the app for each read). In the single-file page they live in localStorage, guarded like App.svelte's.
 */
import { hub } from '../hub/bridge.ts'
import { createTba, localStorageStore, type TbaGet } from '../tba/source.ts'
import { teamNow } from './team-setting.svelte.ts'

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
  if (app) return (path) => app.tba(path)
  return createTba({ key: pageKey!, store: localStorageStore() })
}
