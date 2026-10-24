/**
 * Session renames and mode choices (src/session/mode.ts), kept in this browser and shared by every view that shows a
 * session's mode, so a change made in Match review shows in the Session view and in Foresight at once.
 */
import { withModeChoice, type Mode } from '../session/mode.ts'

const KEY = 'hindsight.sessionRenames'

function read(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}

let names = $state<Record<string, string>>(read())

function save(next: Record<string, string>) {
  names = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private window: not remembered */ }
}

/** The store: session id -> new label, and `mode:<session id>` -> the chosen mode. */
export const sessionNames = (): Record<string, string> => names
export const renameSession = (id: string, label: string): void => save({ ...names, [id]: label })
export const chooseMode = (id: string, mode: Mode | null): void => save(withModeChoice(names, id, mode))
