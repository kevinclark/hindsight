/**
 * The next match number a person typed when no schedule could be read (no key, offline with no saved copy, no team). Kept
 * per event on this laptop (localStorage), under the event's id as the board files notes (`eventIdOf`). It is given to the
 * timeline as its own input (`timeline(..., typedNext)`), never as a one-match schedule (src/board/points.ts says why).
 * Pure: the `Storage` comes in; every access is guarded, since a private window or a full disk throws.
 */

const PREFIX = 'hindsight.nextMatch.'

/** The slice of `Storage` this file uses (a test passes a Map-backed one). */
export type NextStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** "41", "Q41", " q 41 " -> 41; anything else (0, 1.5, "SF1M1", "41 and 42", "") -> null. */
export function parseNext(text: string): number | null {
  const m = /^\s*(?:q\s*)?(\d{1,3})\s*$/i.exec(text)
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The number saved for the first of the event's ids that has one. */
export function readNext(store: NextStore | null, ids: readonly string[]): number | null {
  if (!store) return null
  for (const id of ids) {
    try {
      const v = store.getItem(PREFIX + id)
      const n = v === null ? null : parseNext(v)
      if (n !== null) return n
    } catch { /* unreadable: ask again */ }
  }
  return null
}

/** Save a number under the event's id; null forgets it. Returns false when the store refused. */
export function writeNext(store: NextStore | null, id: string, n: number | null): boolean {
  if (!store) return false
  try {
    if (n === null) store.removeItem(PREFIX + id); else store.setItem(PREFIX + id, String(n))
    return true
  } catch { return false }
}
