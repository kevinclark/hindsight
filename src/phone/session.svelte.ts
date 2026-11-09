/**
 * The iPhone app's steps around the page: signed out → choose the team folder → the read-only pages. PhoneShell.svelte draws
 * them; everything that decides a step is here, so it is tested without a WebView. What it touches comes in as `deps`.
 */
import { SignInAgain } from '../hub/adapter.ts'
import { DriveReader } from '../hub/drive-read.ts'
import { isSignedIn, phoneToken, signIn, signOut } from './google.ts'
import { chooseFolder, forgetFolder, savedFolder, type TeamFolder } from './setup.ts'
import type { HindsightNative } from './native.ts'

export type Step = 'checking' | 'signed-out' | 'folder' | 'ready'

type Fetch = typeof globalThis.fetch

export interface SessionDeps {
  native: HindsightNative
  fetch: Fetch
  store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Put the read-only hub over this folder (src/phone.ts `installPhone`). */
  install(folder: TeamFolder, token: (refresh?: boolean) => Promise<string>, fetch: Fetch): void
  /** Forget the copies of the team's files this phone keeps (the IndexedDB cache). */
  clearCopies(): Promise<void>
  /** Start the pages over: what they hold came from the old folder or account. */
  reload(): void
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class PhoneSession {
  step = $state<Step>('checking')
  folder = $state<TeamFolder | null>(null)
  problem = $state<string | null>(null)
  busy = $state(false)
  /** Google stopped honouring the sign-in while the pages were up: they keep the last copy and offer a sign-in. */
  askAgain = $state(false)
  readonly reader: DriveReader
  private readonly deps: SessionDeps
  private readonly issued: (refresh?: boolean) => Promise<string>

  constructor(deps: SessionDeps) {
    this.deps = deps
    this.folder = savedFolder(deps.store)
    this.issued = phoneToken(deps.native, deps.fetch)
    this.reader = new DriveReader({ rootId: 'root', token: this.token, fetch: deps.fetch })
  }

  /** The Drive readers' token. A refusal Google won't renew: on the pages, a line above them; before them, the sign-in step. */
  readonly token = async (refresh?: boolean): Promise<string> => {
    try { return await this.issued(refresh) } catch (e) {
      if (e instanceof SignInAgain) { if (this.step === 'ready') this.askAgain = true; else this.step = 'signed-out' }
      throw e
    }
  }

  async begin(): Promise<void> {
    try {
      if (!(await isSignedIn(this.deps.native))) { this.step = 'signed-out'; return }
      this.afterSignIn()
    } catch (e) { this.problem = words(e); this.step = 'signed-out' }
  }

  async signIn(): Promise<void> {
    this.busy = true
    this.problem = null
    try {
      await signIn(this.deps.native, this.deps.fetch)
      if (this.askAgain) { this.deps.reload(); return }
      this.afterSignIn()
    } catch (e) {
      // Closing Google's sheet is a choice, not a fault.
      if ((e as { code?: string }).code !== 'CANCELLED') this.problem = words(e)
    } finally { this.busy = false }
  }

  async pick(text: string): Promise<void> {
    this.problem = null
    try { this.open(await chooseFolder(this.reader, text, this.deps.store)) } catch (e) { if (!(e instanceof SignInAgain)) this.problem = words(e) }
  }

  changeFolder(): void {
    forgetFolder(this.deps.store)
    this.deps.reload()
  }

  /** Forget the account on this phone: its refresh token, the team folder, the copies of the team's files. */
  async signOut(): Promise<void> {
    await signOut(this.deps.native)
    forgetFolder(this.deps.store)
    await this.deps.clearCopies()
    this.deps.reload()
  }

  private afterSignIn(): void {
    if (this.folder) this.open(this.folder); else this.step = 'folder'
  }

  private open(folder: TeamFolder): void {
    this.folder = folder
    this.deps.install(folder, this.token, this.deps.fetch)
    this.step = 'ready'
  }
}
