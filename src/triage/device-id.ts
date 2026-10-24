/**
 * The id a board line carries as `by.device`. In the desktop hub it is the library's machine id (electron/hub-ipc.ts,
 * `hub:info`); in the single-file page it is a random id kept in localStorage under its own key, made on the first
 * write. Never a hostname or anything else that names a person or a laptop.
 */
export const DEVICE_ID_KEY = 'hindsight.deviceId'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/** Used when storage throws (a private window): one random id for this page session. */
let sessionId: string | null = null

export function deviceId(store: Store, random: () => string = () => crypto.randomUUID()): string {
  try {
    const kept = store.getItem(DEVICE_ID_KEY)
    if (kept) return kept
  } catch {
    return sessionDeviceId(random)
  }
  const made = random()
  try {
    store.setItem(DEVICE_ID_KEY, made)
  } catch {
    return sessionDeviceId(random)
  }
  return made
}

function sessionDeviceId(random: () => string): string {
  sessionId ??= random()
  return sessionId
}
