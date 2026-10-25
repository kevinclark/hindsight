<!--
  "Set up this laptop" (ADR b): the settings a lead sets once, each with what it adds, each optional, none blocking anything.
  A step ticks when it is set and has one field or button; the whole card is hidden once every step that applies to this
  build is done. Needs nothing from its parent: the Now screen mounts it as it is. `onOpenLibrary` (optional) is where the
  Google step sends someone for what takes more than a button (pasting a Google client, choosing the team folder).
  Never shows the read key back.
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import { hub, type DriveStatus } from '../hub/bridge.ts'
  import { codeFolder } from './code-folder.svelte.ts'
  import { saveSetup, tbaHasKey, tbaTeam } from './tba-setting.svelte.ts'
  import { setupProgress, setupSteps, showSetupCard, type SetupStepId } from './setup-steps.ts'

  let { onOpenLibrary }: { onOpenLibrary?: () => void } = $props()
  const api = hub()

  let sources = $state<string[]>([])
  let drive = $state<DriveStatus | null>(null)
  let teamText = $state('')
  let keyText = $state('')
  let githubText = $state('')
  let problem = $state<{ step: SetupStepId; text: string } | null>(null)
  let busy = $state(false)

  async function load() {
    if (!api) return
    try { sources = (await api.team()).sources } catch { /* leave the step open */ }
    try { drive = await api.driveStatus() } catch { drive = null }
  }
  onMount(() => { void load() })

  const steps = $derived(setupSteps({
    hub: !!api, team: tbaTeam(), tbaKey: tbaHasKey(),
    github: api ? sources.length > 0 : !!codeFolder.chosen,
    google: { configured: !!drive?.configured, signedIn: !!drive?.signedIn, teamFolder: !!drive?.teamFolder },
  }))

  async function run(step: SetupStepId, work: () => Promise<string | null>) {
    busy = true
    const text = await work().catch((e) => (e instanceof Error ? e.message : 'Could not save.'))
    busy = false
    problem = text ? { step, text } : null
    if (!text) await load()
  }
  const saveTeam = () => run('team', async () => {
    if (!/^\s*\d{1,5}\s*$/.test(teamText) || Number(teamText) === 0) return 'A team number is a whole number from 1 to 99999.'
    const r = await saveSetup({ team: Number(teamText) })
    if (!r) teamText = ''
    return r
  })
  const saveKey = () => run('tba', async () => {
    if (!keyText.trim()) return 'Paste the key first.'
    const r = await saveSetup({ key: keyText })
    keyText = ''
    return r
  })
  const saveGithub = () => run('github', async () => {
    const list = githubText.split(/[\s,]+/).filter(Boolean)
    if (!list.length) return 'Type an organization or owner/repo.'
    if (!api) return codeFolder.useGitHub(list[0].includes('@') ? list[0] : `${list[0]}@main`) ? (githubText = '', null) : codeFolder.problem
    const r = await saveSetup({ sources: [...new Set([...sources, ...list])] })
    if (!r) githubText = ''
    return r
  })
  async function google() {
    if (!api || !drive) return
    if (drive.configured && !drive.signedIn) { busy = true; try { await api.driveSignIn() } catch (e) { problem = { step: 'google', text: e instanceof Error ? e.message : 'Sign-in did not finish.' } } busy = false; await load() }
    else onOpenLibrary?.()
  }
</script>

{#if showSetupCard(steps)}
  <section class="setup" aria-labelledby="setup-title" data-setup-card>
    <h3 id="setup-title">Set up this laptop</h3>
    <p class="muted">Once, by a lead · {setupProgress(steps).done} of {setupProgress(steps).of} done · optional · each step says what it adds</p>
    <ol>
      {#each steps.filter((x) => x.applicable) as step (step.id)}
        <li class:done={step.done}>
          <span class="tick" aria-hidden="true">{step.done ? '✓' : '○'}</span>
          <div class="what">
            <strong>{step.title}</strong>{' '}<span class="state">{step.done ? '(set)' : '(not set)'}</span>
            <span class="adds">· {step.adds}</span>
            {#if !step.done}
              {#if step.id === 'team'}
                <form onsubmit={(e) => { e.preventDefault(); void saveTeam() }}>
                  <label for="setup-team">Team number</label>
                  <input id="setup-team" inputmode="numeric" autocomplete="off" size="6" bind:value={teamText} /><button type="submit" disabled={busy}>Save</button>
                </form>
              {:else if step.id === 'tba'}
                <form onsubmit={(e) => { e.preventDefault(); void saveKey() }}>
                  <label for="setup-key">Read key</label>
                  <input id="setup-key" type="password" autocomplete="off" size="22" placeholder="paste the key" bind:value={keyText} /><button type="submit" disabled={busy}>Save</button>
                </form>
              {:else if step.id === 'github'}
                <form onsubmit={(e) => { e.preventDefault(); void saveGithub() }}>
                  <label for="setup-github">{api ? 'Organization or owner/repo' : 'Repo and branch'}</label>
                  <input id="setup-github" autocomplete="off" spellcheck="false" size="26" placeholder={api ? 'organization or owner/repo' : 'owner/repo@branch'} bind:value={githubText} /><button type="submit" disabled={busy}>Save</button>
                </form>
              {:else if step.id === 'google'}
                <button type="button" disabled={busy || !drive} onclick={() => void google()}>{!drive ? '…' : drive.configured && !drive.signedIn ? 'Sign in with Google' : drive.configured ? 'Choose the team folder…' : 'Set up Google…'}</button>
              {/if}
              {#if problem?.step === step.id}<p class="problem" role="alert">{problem.text}</p>{/if}
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .setup { border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 1rem; margin: 0.75rem 0; }
  h3 { margin: 0 0 0.2rem; font-size: 1.05rem; }
  .muted, .adds, .state { color: var(--muted); }
  ol { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.6rem; }
  li { display: flex; gap: 0.6rem; }
  .tick { width: 1.2rem; flex: none; }
  form { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.6rem; margin-top: 0.3rem; }
  input { min-height: 28px; box-sizing: border-box; padding: 0.2rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit; max-width: 100%; }
  button { min-height: 28px; min-width: 28px; padding: 0.2rem 0.9rem; margin-top: 0.3rem; border: 1px solid var(--focus); border-radius: 6px; background: none; color: var(--fg); font: inherit; cursor: pointer; }
  form button { margin-top: 0; }
  .setup form input { width: 13rem; }
  .setup form input[inputmode='numeric'] { width: 6rem; }
  button:disabled { border-color: var(--border); color: var(--muted); cursor: default; }
  ::placeholder { color: var(--muted); opacity: 1; }
  .problem { color: var(--error); margin: 0.2rem 0 0; }
</style>
