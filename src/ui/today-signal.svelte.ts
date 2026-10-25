/**
 * Whether today is an event day when the Session view holds no logs of it, and the laptop's clock: one read of The Blue
 * Alliance's team events and of the library, shared by Now and Foresight (App.svelte makes one and hands it to both).
 * Call it while a component initialises (it sets up effects). The mode line they both show is `todayMode(sessions, clock,
 * sessionNames(), external)` (src/session/mode.ts).
 *
 * The schedule's events are read once (the answer for a day is worked out from them each time); the library is read again as
 * the day goes on (when a job ends), so a log pulled in that day flips Practice to Event without a reload. The single-file
 * page has neither, and keeps the old behaviour: no outside signal.
 */
import { hub } from '../hub/bridge.ts'
import type { LogRecord } from '../hub/types.ts'
import { eventFromLibrary, eventFromSchedule, type TodayEvent } from '../session/today-event.ts'
import { teamEvents } from '../tba/api.ts'
import { tbaGetter, tbaTeam } from './tba-setting.svelte.ts'

export function todaySignal() {
  let clock = $state(Date.now())
  $effect(() => { const t = setInterval(() => { clock = Date.now() }, 30_000); return () => clearInterval(t) })
  let tbaEvents = $state.raw<Parameters<typeof eventFromSchedule>[0]>([])
  let libraryLogs = $state.raw<LogRecord[]>([])
  let libraryLoaded = $state(false)
  let libraryReadAt = 0
  let reading = false
  async function readLibrary() {
    const app = hub()
    if (!app) return
    libraryReadAt = Date.now()
    reading = true
    try { libraryLogs = (await app.library()).entries.map((e) => e.record) } catch { /* no library answer: the last one stands */ } finally { reading = false; libraryLoaded = true }
  }
  $effect(() => {
    const app = hub()
    if (!app) return
    const get = tbaGetter(), team = tbaTeam()
    let cancelled = false
    void (async () => {
      try { if (get && team !== null) { const events = (await teamEvents(get, team, new Date().getFullYear())).data; if (!cancelled) tbaEvents = events } } catch { /* offline with no saved copy, or no key: the library is next */ }
    })()
    void readLibrary()
    const stop = app.onProgress((p) => { if (p === null) void readLibrary() })
    return () => { cancelled = true; stop() }
  })
  const external = $derived<TodayEvent | null>(eventFromSchedule(tbaEvents, clock) ?? eventFromLibrary(libraryLogs, clock))
  return {
    /** The laptop's clock, moved every 30 s. */
    get clock() { return clock },
    /** The event day the outside signals say it is, or null. */
    get external() { return external },
    /** The library's log records as last read (hub only; empty on the page). */
    get libraryLogs() { return libraryLogs },
    /** The library has been read once (the desktop app), so whether it holds logs is known. */
    get libraryLoaded() { return libraryLoaded },
    /** Read the library again unless a read is in flight or the last one was within `ms`. */
    readLibraryIfOlder(ms: number) { if (hub() && !reading && Date.now() - libraryReadAt > ms) void readLibrary() },
    readLibrary,
  }
}

export type TodaySignal = ReturnType<typeof todaySignal>
