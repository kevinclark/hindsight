/**
 * Which event the phone shows (Now, the board in Session, Session): today's The Blue Alliance event when there is one, so
 * at a competition the board is always today's; else the event the person picked; else the one a laptop published to
 * most recently. The pick is kept in the app's storage.
 */
const KEY = 'hindsight.phone.event'
type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function phoneEvent(today: string | null, picked: string | null, published: readonly string[]): string | null {
  if (today) return today
  if (picked && published.includes(picked)) return picked
  return published[0] ?? null
}

export function pickedEvent(store: KeyStore): string | null {
  try { return store.getItem(KEY) } catch { return null }
}

export function pickEvent(store: KeyStore, key: string | null): void {
  try { if (key) store.setItem(KEY, key); else store.removeItem(KEY) } catch { /* lasts until the app closes */ }
}

export interface EventInfo { name: string; start: string }

/**
 * The published events in the order the phone offers them: by The Blue Alliance's start date, newest first, when known
 * (the order Drive last changed them in is not it: a laptop publishing old events pushes the oldest last); events TBA
 * does not know keep the order given, after them.
 */
export function orderEvents(keys: readonly string[], info: ReadonlyMap<string, EventInfo>): string[] {
  const known = keys.filter((k) => info.has(k)).sort((a, b) => info.get(b)!.start.localeCompare(info.get(a)!.start))
  return [...known, ...keys.filter((k) => !info.has(k))]
}

/** "2025 Madtown ThrowDown" for a known event, else the key. */
export const eventLabel = (key: string, info: ReadonlyMap<string, EventInfo>): string => {
  const i = info.get(key)
  return i ? `${key.slice(0, 4)} ${i.name}` : key
}
