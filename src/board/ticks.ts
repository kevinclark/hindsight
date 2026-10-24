/** Shared by Foresight's checklists and the board's queue sheet, so both age a tick the same way. */
/** A tick is Done for this long, then it reads "(old)" and the system is unticked: a check made long ago says nothing about now. */
export const TICK_MINUTES = 90

export interface Tick { role: string; when: string; old: boolean; /** Dated after now: this laptop's clock is behind the one that wrote it, so it cannot be told fresh. */ ahead: boolean }

/** A tick as read at `now`. */
export const tickAt = (role: string, when: string, now: number): Tick => {
  const age = now - Date.parse(when)
  return { role, when, ahead: age < 0, old: !(age >= 0 && age <= TICK_MINUTES * 60e3) }
}
