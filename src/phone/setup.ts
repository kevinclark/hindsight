/**
 * The phone's one setting besides the sign-in: which Drive folder is the team folder. Its id and name are kept in the
 * WebView's storage (an id is not a secret: it opens nothing without a sign-in that can see the folder).
 */
import { folderIdFrom } from '../hub/drive-read.ts'

export interface TeamFolder { id: string; name: string }

type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const KEY = 'hindsight.phone.teamFolder'

export function savedFolder(store: KeyStore): TeamFolder | null {
  try {
    const f = JSON.parse(store.getItem(KEY) ?? 'null') as Partial<TeamFolder> | null
    return f && typeof f.id === 'string' && typeof f.name === 'string' ? { id: f.id, name: f.name } : null
  } catch { return null }
}

export function forgetFolder(store: KeyStore): void {
  try { store.removeItem(KEY) } catch { /* nothing kept */ }
}

/** From a picked id or a pasted link: the folder, if Drive shows it to this account; kept for next time. Throws words. */
export async function chooseFolder(reader: { describeFolder(id: string): Promise<TeamFolder | null> }, text: string, store: KeyStore): Promise<TeamFolder> {
  const id = folderIdFrom(text)
  if (!id) throw new Error('That is not a Drive folder link or id.')
  const folder = await reader.describeFolder(id)
  if (!folder) throw new Error('Drive cannot show that folder to this account (is it a folder you can open?).')
  try { store.setItem(KEY, JSON.stringify(folder)) } catch { /* kept until the app closes */ }
  return folder
}
