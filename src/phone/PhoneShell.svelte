<!-- The iPhone app around the page: sign in with Google, choose the team folder, then the read-only pages (App). A sign-in
     Google stops honouring shows a line above them, keeping the last copy on screen. -->
<script lang="ts">
  import App from '../App.svelte'
  import DriveFolderPicker from '../ui/DriveFolderPicker.svelte'
  import { DriveReader } from '../hub/drive-read.ts'
  import { SignInAgain } from '../hub/adapter.ts'
  import { installPhone } from '../phone.ts'
  import { isSignedIn, phoneToken, signIn, signOut } from './google.ts'
  import { chooseFolder, forgetFolder, savedFolder, type TeamFolder } from './setup.ts'
  import { native, viaNative as nativeFetch } from './runtime.ts'

  let step = $state<'checking' | 'signed-out' | 'folder' | 'ready'>('checking')
  let folder = $state<TeamFolder | null>(savedFolder(localStorage))
  let problem = $state<string | null>(null)
  let busy = $state(false)
  let askAgain = $state(false)

  const issued = phoneToken(native, nativeFetch)
  /** The reader's token: a refusal Google won't renew asks for a sign-in on a line above the pages. */
  async function token(refresh?: boolean): Promise<string> {
    try { return await issued(refresh) } catch (e) { if (e instanceof SignInAgain) askAgain = true; throw e }
  }
  const reader = new DriveReader({ rootId: 'root', token, fetch: nativeFetch })

  function open(f: TeamFolder) {
    installPhone({ rootId: f.id, token, fetch: nativeFetch })
    step = 'ready'
  }

  async function begin() {
    if (!(await isSignedIn(native))) { step = 'signed-out'; return }
    if (folder) open(folder); else step = 'folder'
  }
  void begin().catch((e) => { problem = e instanceof Error ? e.message : String(e); step = 'signed-out' })

  async function doSignIn() {
    busy = true
    problem = null
    try {
      await signIn(native, nativeFetch)
      if (askAgain) { location.reload(); return }
      if (folder) open(folder); else step = 'folder'
    } catch (e) {
      // Closing Google's sheet is a choice, not a fault.
      if ((e as { code?: string }).code !== 'CANCELLED') problem = e instanceof Error ? e.message : String(e)
    } finally { busy = false }
  }

  async function pick(text: string) {
    problem = null
    try { folder = await chooseFolder(reader, text, localStorage); open(folder) } catch (e) { problem = e instanceof Error ? e.message : String(e) }
  }

  // Changing the folder or the account starts the pages over: what they hold came from the old one.
  function changeFolder() { forgetFolder(localStorage); location.reload() }
  async function leave() { await signOut(native); location.reload() }
</script>

{#if step === 'ready'}
  {#if askAgain}<p class="again" role="alert">Google asked to sign in again: what you see is the last copy. <button class="primary" onclick={doSignIn} disabled={busy}>Sign in with Google</button></p>{/if}
  <App />
  <footer class="shell">
    <p>Team folder: {folder?.name} · <button class="link" onclick={changeFolder}>Change</button> · <button class="link" onclick={leave}>Sign out</button></p>
    <p>This app only reads the team folder: marks are made on a laptop.</p>
  </footer>
{:else if step !== 'checking'}
  <main class="setup">
    <h1>Hindsight</h1>
    {#if step === 'signed-out'}
      <p>What your team's laptops found and marked at this event, from your team's Google Drive folder. Sign in with the Google account that can open that folder. This app only reads it.</p>
      <button class="primary" onclick={doSignIn} disabled={busy}>{busy ? 'Signing in…' : 'Sign in with Google'}</button>
    {:else}
      <p>Choose your team's Hindsight folder: the one your laptops sync to.</p>
      <DriveFolderPicker api={{ driveFolders: (id: string) => reader.folderChoices(id) }} label="Use this folder" onPick={pick} onCancel={leave} />
    {/if}
    {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
  </main>
{/if}

<style>
  .setup { max-width: 32rem; }
  h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
  .setup p { line-height: 1.45; }
  .primary { font: inherit; color: var(--fg); padding: 0.5rem 1rem; border: 1px solid var(--focus); border-radius: 8px; background: none; cursor: pointer; }
  .primary:disabled { border-color: var(--border); color: var(--muted); }
  .problem { color: var(--error); }
  .again { padding: 0.5rem 0.75rem; border: 1px solid var(--warning); border-radius: 8px; }
  .shell { margin-top: 2.5rem; padding-top: 0.75rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; }
  .shell p { margin: 0.25rem 0; }
  .link { font: inherit; border: none; background: none; color: var(--fg); text-decoration: underline; cursor: pointer; padding: 0 0.2rem; }
</style>
