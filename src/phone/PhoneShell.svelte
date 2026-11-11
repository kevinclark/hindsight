<!-- The iPhone app around the page: sign in with Google, choose the team folder, then the read-only pages (App). A sign-in
     Google stops honouring shows a line above them, keeping the last copy on screen. -->
<script lang="ts">
  import App from '../App.svelte'
  import DriveFolderPicker from '../ui/DriveFolderPicker.svelte'
  import { forgetPhoneData, installPhone } from '../phone.ts'
  import { installFixture as installSample } from '../phone-fixture.ts'
  import { PhoneSession } from './session.svelte.ts'
  import { native, viaNative, webFetch } from './runtime.ts'

  const s = new PhoneSession({
    native, fetch: viaNative, store: localStorage,
    // Requests go through native HTTP; whole logs through the WebView's own fetch (never base64 across the bridge).
    install: (folder, token) => installPhone({ rootId: folder.id, token, fetch: viaNative, mediaFetch: webFetch }),
    installSample: () => installSample(),
    clearCopies: forgetPhoneData,
    reload: () => location.reload(),
  })
  void s.begin()
</script>

{#if s.step === 'ready'}
  {#if s.sample}<p class="again" role="status">Sample data: an invented event, not your team's. <button class="primary" onclick={() => s.leaveSample()}>Sign in with Google</button></p>{/if}
  {#if s.askAgain}<p class="again" role="alert">Google asked to sign in again: what you see is the last copy. <button class="primary" onclick={() => s.signIn()} disabled={s.busy}>Sign in with Google</button></p>{/if}
  <App />
  <footer class="shell">
    {#if s.sample}<p>Sample data · <button class="link" onclick={() => s.leaveSample()}>Sign in</button></p>{:else}<p>Team folder: {s.folder?.name} · <button class="link" onclick={() => s.changeFolder()}>Change</button> · <button class="link" onclick={() => s.signOut()}>Sign out</button></p>{/if}
    <p>This app only reads the team folder: marks are made on a laptop.</p>
  </footer>
{:else if s.step !== 'checking'}
  <main class="setup">
    <h1>Hindsight</h1>
    {#if s.step === 'signed-out'}
      <p>What your team's laptops found and marked at this event, and any of the team's logs, from your team's Google Drive folder. Sign in with the Google account that can open that folder. This app only reads it.</p>
      <button class="primary" onclick={() => s.signIn()} disabled={s.busy}>{s.busy ? 'Signing in…' : 'Sign in with Google'}</button>
      <p><button class="link" onclick={() => s.trySample()}>Try with sample data</button> <span class="meta">an invented event, to look around first</span></p>
    {:else}
      <p>Choose your team's Hindsight folder: the one your laptops sync to.</p>
      <DriveFolderPicker api={{ driveFolders: (id: string) => s.reader.folderChoices(id) }} label="Use this folder" onPick={(text) => s.pick(text)} onCancel={() => s.signOut()} cancelLabel="Sign out" />
    {/if}
    {#if s.problem}<p class="problem" role="alert">{s.problem}</p>{/if}
  </main>
{/if}

<style>
  .setup { max-width: 32rem; }
  /* The desktop picker's list is two columns in a 12rem box; on a phone that clips, so: one column, all of it, scrolled with the page. */
  .setup :global(.picker ul) { columns: 1; max-height: none; overflow: visible; font-size: 1rem; }
  .setup :global(.picker li .link) { min-height: 44px; text-align: left; }
  h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
  .setup p { line-height: 1.45; }
  .primary { font: inherit; color: var(--fg); padding: 0.5rem 1rem; border: 1px solid var(--focus); border-radius: 8px; background: none; cursor: pointer; }
  .primary:disabled { border-color: var(--border); color: var(--muted); }
  .problem { color: var(--error); }
  .meta { color: var(--muted); font-size: 0.85rem; }
  .again { padding: 0.5rem 0.75rem; border: 1px solid var(--warning); border-radius: 8px; }
  .shell { margin-top: 2.5rem; padding-top: 0.75rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.85rem; }
  .shell p { margin: 0.25rem 0; }
  .link { font: inherit; border: none; background: none; color: var(--fg); text-decoration: underline; cursor: pointer; padding: 0 0.2rem; }
</style>
