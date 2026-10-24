/**
 * The id a board line carries as `by.device`. In the desktop hub it is the library's machine id (electron/hub-ipc.ts,
 * `hub:info`); in the single-file page it is a random id kept in localStorage under its own key, made on the first
 * write. Never a hostname or anything else that names a person or a laptop.
 */
export const DEVICE_ID_KEY = 'hindsight.deviceId'

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function deviceId(store: Store, random: () => string = () => crypto.randomUUID()): string {
  const kept = store.getItem(DEVICE_ID_KEY)
  if (kept) return kept
  const made = random()
  store.setItem(DEVICE_ID_KEY, made)
  return made
}
