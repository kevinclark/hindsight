/**
 * The typed next match number as something views react to: every Session view / Foresight board reads it through here, so
 * a number typed in one place re-derives the others at once. Storage and parsing: src/board/typed-next.ts.
 */
import { eventIdsOf } from '../board/model.ts'
import { readNext, writeNext, parseNext } from '../board/typed-next.ts'
import type { Session } from '../session/session.ts'

const store = (): Storage | null => { try { return localStorage } catch { return null } }

/** Bumped on each save so a `$derived` that calls `typedNextFor` runs again. */
let version = $state(0)
/** Numbers typed while storage refused (a private window): they last until the page closes. */
const kept = new Map<string, number>()

export function typedNextFor(session: Pick<Session, 'event' | 'matches' | 'label'> | null | undefined): number | null {
  void version
  if (!session) return null
  const ids = eventIdsOf(session)
  return ids.map((i) => kept.get(i)).find((n) => n !== undefined) ?? readNext(store(), ids)
}

/** Save what was typed ("41" or "Q41"); returns false when it is not a match number. */
export function saveTypedNext(session: Pick<Session, 'event' | 'matches' | 'label'>, text: string): boolean {
  const n = parseNext(text)
  if (n === null) return false
  const id = eventIdsOf(session)[0]
  if (!writeNext(store(), id, n)) kept.set(id, n)
  version++
  return true
}
