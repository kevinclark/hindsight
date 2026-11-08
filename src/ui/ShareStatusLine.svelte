<!--
  What of this laptop's marks and match summaries is not on the team Drive yet, and when teammates' marks last came down
  (src/hub/live-share.ts), plus why the latest event is not published for the phone. Desktop app only.
-->
<script lang="ts">
  import type { HubApi, ShareStatus } from '../hub/bridge.ts'
  import { publishNote } from './event-share.svelte.ts'
  let { api }: { api: HubApi } = $props()
  let status = $state<ShareStatus | null>(null)
  $effect(() => {
    void api.shareStatus().then((s) => { status = s }).catch(() => {})
    return api.onShareStatus((s) => { status = s })
  })
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const waiting = $derived(status ? [status.notUp.marks ? plural(status.notUp.marks, 'mark', 'marks') : '', status.notUp.eventLines ? plural(status.notUp.eventLines, 'match summary', 'match summaries') : ''].filter(Boolean).join(' and ') : '')
  const line = $derived.by(() => {
    if (!status) return ''
    const notUp = waiting ? `${waiting} not on the team Drive yet` : ''
    if (status.signInNeeded) return `Sign in to Google again to share marks and matches${notUp ? `: ${notUp}` : ''}.`
    if (!status.running) return notUp ? `${notUp}: they go up once this laptop uses its Drive sign-in (Sync, or adding from Drive).` : ''
    const as = status.teammatesAsOf ? ` · teammates' marks as of ${clock(status.teammatesAsOf)}` : ''
    return `${notUp || 'Marks and match summaries are on the team Drive'}${as}.`
  })
</script>

{#if line || status?.problem || publishNote()}
  <p class="share" role="status" data-share-status>
    {line}{#if status?.problem}{' '}<span class="warn">{status.problem}</span>{/if}{#if publishNote()}{' '}<span class="warn">{publishNote()}</span>{/if}
  </p>
{/if}

<style>
  .share { margin: 0.25rem 0 0.5rem; color: var(--muted); font-size: 0.85rem; }
  .warn { color: var(--warning); }
</style>
