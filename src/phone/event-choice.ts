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
