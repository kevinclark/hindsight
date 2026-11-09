/**
 * The phone's way in: a read-only hub over the team's Drive folder, installed before the page mounts. The sign-in is the
 * shell's (the iPhone app: src/phone/), so the token source is injected; nothing here knows how a token is got. No `node:`
 * imports.
 */
import { BrowserHub } from './hub/browser-hub.ts'
import { DriveReader } from './hub/drive-read.ts'
import { indexedDbCache, type ReadStore } from './hub/phone-cache.ts'
import { VERSION } from './version.ts'

export interface PhoneSetup {
  /** The team folder's Drive id (chosen at run time, never in this repository). */
  rootId: string
  /** A current access token with drive.readonly; `refresh` asks for a new one (the last was refused). Throws SignInAgain when it can't. */
  token(refresh?: boolean): Promise<string>
  /** How requests reach Drive (the iPhone app: its native HTTP). The page's own fetch when absent. */
  fetch?: typeof fetch
}

/** Install the phone's hub over Drive. Call before mounting App. */
export function installPhone(setup: PhoneSetup): BrowserHub {
  return installPhoneOver(new DriveReader({ rootId: setup.rootId, token: setup.token, ...(setup.fetch ? { fetch: setup.fetch } : {}) }))
}

/** The same over any read-only store (the demo fixture, tests). */
export function installPhoneOver(store: ReadStore): BrowserHub {
  const hub = new BrowserHub({ store, cache: indexedDbCache(), version: VERSION })
  ;(window as unknown as { hindsightPhone: BrowserHub }).hindsightPhone = hub
  return hub
}
