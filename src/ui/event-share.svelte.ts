/** Why the laptop is not publishing the latest event for the phone (no TBA key, no event found), for the Library to say. Set by App.svelte. */
let note = $state<string | null>(null)
export const publishNote = (): string | null => note
export const setPublishNote = (text: string | null): void => { note = text }
