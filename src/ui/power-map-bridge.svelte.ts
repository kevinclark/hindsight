/**
 * What the power map screen, the Breakers strip and the finding thumbnail share, held once for the app (App.svelte sets it):
 * the team's history (to read the map in effect), a way to write a history line, which map to show next (a robot, a slot, and
 * from which match the change applies), and a way to open the screen. Views read it; none of them owns the history.
 */
import type { BoardRole, HistoryEvent } from '../triage/history.ts'

export interface MapFocus {
  /** The robot's profile id; unset: the one last used. */
  robot?: string
  /** A PDP slot to open the popover on. */
  slot?: number
  /** Opened from a finding: the change takes effect from this match's start (ISO), named for the toast. Unset: from now. */
  from?: { iso: string; label: string }
}

export type MapWriter = (build: (device: string, history: HistoryEvent[]) => HistoryEvent[]) => void

let history = $state.raw<HistoryEvent[]>([])
let focus = $state.raw<MapFocus | null>(null)
let writer: MapWriter | null = null
let role: () => BoardRole | null = () => null
let opener: (() => void) | null = null

export const mapHistory = (): HistoryEvent[] => history
export const setMapHistory = (h: HistoryEvent[]) => { history = h }
export const mapFocus = (): MapFocus | null => focus
export const clearMapFocus = () => { focus = null }
export const setMapWriter = (w: MapWriter, r: () => BoardRole | null, open: () => void) => { writer = w; role = r; opener = open }
export const writeMapLine = (build: (device: string, history: HistoryEvent[], role: BoardRole) => HistoryEvent[]) => {
  writer?.((device, h) => build(device, h, role() ?? 'pit'))
}
/** Open the power map screen, on this robot / slot / from this match. */
export function openPowerMap(f: MapFocus = {}) {
  focus = f
  opener?.()
}

/** The robot last used on the power map screen (kept per laptop; reactive, so a strip that falls back to it follows), or null. */
export const LAST_ROBOT_KEY = 'hindsight.powermap.robot'
let lastRobot = $state<string | null>((() => { try { return localStorage.getItem(LAST_ROBOT_KEY) } catch { return null } })())
export const lastMapRobot = (): string | null => lastRobot
export function setLastMapRobot(id: string): void {
  lastRobot = id
  try { localStorage.setItem(LAST_ROBOT_KEY, id) } catch { /* not remembered */ }
}
