/**
 * The phone's way in: a read-only hub over the team's Drive folder, installed before the page mounts. The sign-in is the
 * shell's (the iPhone app: src/phone/), so the token source is injected; nothing here knows how a token is got. No `node:`
 * imports.
 */
import { BrowserHub, type BrowserHubOptions } from './hub/browser-hub.ts'
import { DriveReader } from './hub/drive-read.ts'
import { indexedDbCache, type ReadStore } from './hub/phone-cache.ts'
import { LogKeep, indexedDbKeepStore } from './hub/log-keep.ts'
import { keepCap } from './phone/keep-setting.ts'
import { clearIndexedDbCache } from './hub/phone-cache.ts'

/** Logs kept on the phone after opening (src/hub/log-keep.ts). */
export const keptLogs = () => new LogKeep(indexedDbKeepStore(), { capBytes: keepCap(globalThis.localStorage) })

/** Sign out: forget the copies of the team's files and the kept logs on this phone. */
export async function forgetPhoneData(): Promise<void> {
  await clearIndexedDbCache()
  // Through the hub when there is one, so a log still being stored is waited for, not left behind.
  const hub = (globalThis as unknown as { hindsightPhone?: BrowserHub }).hindsightPhone
  if (hub) await hub.clearKept()
  await keptLogs().clear()
}
import { VERSION } from './version.ts'

export interface PhoneSetup {
  /** The team folder's Drive id (chosen at run time, never in this repository). */
  rootId: string
  /** A current access token with drive.readonly; `refresh` asks for a new one (the last was refused). Throws SignInAgain when it can't. */
  token(refresh?: boolean): Promise<string>
  /** How requests reach Drive (the iPhone app: its native HTTP). The page's own fetch when absent. */
  fetch?: typeof fetch
  /**
   * How whole logs are downloaded (the iPhone app: the WebView's own fetch, so a big log is never carried across the
   * native bridge as base64). Without it the Library lists logs but cannot open them.
   */
  mediaFetch?: typeof fetch
}

/** Install the phone's hub over Drive. Call before mounting App. */
export function installPhone(setup: PhoneSetup): BrowserHub {
  const reader = (f?: typeof fetch) => new DriveReader({ rootId: setup.rootId, token: setup.token, ...(f ? { fetch: f } : {}) })
  return installPhoneOver(reader(setup.fetch), setup.mediaFetch ? reader(setup.mediaFetch) : undefined)
}

/** The same over any read-only store (the demo fixture, tests). */
export function installPhoneOver(store: ReadStore, media?: BrowserHubOptions['media']): BrowserHub {
  const hub = new BrowserHub({ store, cache: indexedDbCache(), version: VERSION, ...(media ? { media, keep: keptLogs() } : {}) })
  ;(globalThis as unknown as { hindsightPhone: BrowserHub }).hindsightPhone = hub
  return hub
}
