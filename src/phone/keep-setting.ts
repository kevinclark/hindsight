/** How much the phone keeps of the logs it opened (src/hub/log-keep.ts): the person's choice, 1 GB to start. */

const KEY = 'hindsight.phone.keepBytes'
const MB = 2 ** 20
const GB = 2 ** 30

export const KEEP_CHOICES = [
  { bytes: 0, label: 'Nothing' },
  { bytes: 500 * MB, label: '500 MB' },
  { bytes: GB, label: '1 GB' },
  { bytes: 2 * GB, label: '2 GB' },
  { bytes: 5 * GB, label: '5 GB' },
] as const
export const KEEP_DEFAULT = GB

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>

export function keepCap(store: KeyStore): number {
  try {
    const n = Number(store.getItem(KEY))
    return KEEP_CHOICES.some((c) => c.bytes === n) && store.getItem(KEY) !== null ? n : KEEP_DEFAULT
  } catch { return KEEP_DEFAULT }
}

export function setKeepCap(store: KeyStore, bytes: number): void {
  try { store.setItem(KEY, String(bytes)) } catch { /* lasts until the app closes */ }
}
