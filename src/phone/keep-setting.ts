/** How much the phone keeps of the logs it opened (src/hub/log-keep.ts): the person's choice, 1 GB to start. */

const KEY = 'hindsight.phone.keepBytes'
const MB = 2 ** 20
const GB = 2 ** 30

export const KEEP_CHOICES = [
  { bytes: 0, label: 'None' },
  { bytes: 500 * MB, label: 'Up to 500 MB' },
  { bytes: GB, label: 'Up to 1 GB' },
  { bytes: 2 * GB, label: 'Up to 2 GB' },
  { bytes: 5 * GB, label: 'Up to 5 GB' },
] as const
export const KEEP_DEFAULT = GB

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>

export function keepCap(store: KeyStore): number {
  try {
    const raw = store.getItem(KEY)
    if (raw === null || raw.trim() === '') return KEEP_DEFAULT
    const n = Number(raw)
    return KEEP_CHOICES.some((c) => c.bytes === n) ? n : KEEP_DEFAULT
  } catch { return KEEP_DEFAULT }
}

export function setKeepCap(store: KeyStore, bytes: number): void {
  try { store.setItem(KEY, String(bytes)) } catch { /* lasts until the app closes */ }
}
