/**
 * "You are on: pit / software / drive / mentor": the role a board line is written under (ADR 1). A local setting of this
 * laptop (localStorage, its own key), asked once and changeable from the board. It is never a name: a line carries a device
 * id and a role, and the screen shows only the role.
 */
import type { BoardRole } from '../triage/history.ts'

export const ROLE_KEY = 'hindsight.board.role'
export const ROLES: readonly BoardRole[] = ['pit', 'software', 'drive', 'mentor']
/** The roles that can own an issue (a mentor coaches and can take over, but a student role owns: ADR 1). */
export const OWNER_ROLES: readonly BoardRole[] = ['pit', 'software', 'drive']

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** This laptop's role, or null when none was chosen yet (or storage is blocked and nothing was chosen this visit). */
export function readRole(store: Store): BoardRole | null {
  try {
    const v = store.getItem(ROLE_KEY)
    return ROLES.includes(v as BoardRole) ? (v as BoardRole) : null
  } catch { return null }
}

/** Keep the role. A blocked store loses it at reload: the caller still holds it for this visit. */
export function writeRole(store: Store, role: BoardRole): void {
  try { store.setItem(ROLE_KEY, role) } catch { /* a private window: kept for this visit only */ }
}
