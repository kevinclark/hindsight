/** Shared by Foresight's checklists and the board's queue sheet, so both age a tick the same way. */
/** A tick is Done for this long, then it reads "(old)" and the system is unticked: a check made long ago says nothing about now. */
export const TICK_MINUTES = 90

/** A tick written up to this long "in the future" still reads fresh: a tick just made on a laptop whose clock runs a little behind the one reading it. */
export const TICK_SKEW_MINUTES = 5

export interface Tick { role: string; when: string; old: boolean; /** Dated more than TICK_SKEW_MINUTES after now: the laptop that wrote it is well ahead of this one, so it cannot be told fresh. */ ahead: boolean }

/**
 * A tick as read at `now`: fresh while -5 min <= age <= 90 min. `ahead` only below -5 min: a teammate's laptop more than
 * 5 minutes ahead still reads "clock ahead: tick again".
 */
export const tickAt = (role: string, when: string, now: number): Tick => {
  const age = now - Date.parse(when)
  return { role, when, ahead: age < -TICK_SKEW_MINUTES * 60e3, old: !(age >= -TICK_SKEW_MINUTES * 60e3 && age <= TICK_MINUTES * 60e3) }
}
