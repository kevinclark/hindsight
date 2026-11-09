# update state contract (`src/hub/update-state.ts`)

Intent: the app says, in one label at the right of the tabs, whether this copy of Hindsight is up to date, what it is
doing about a newer release, and what the user can do. `update-state.ts` is the whole decision: a pure reducer (`step`)
over what the updater reports, and a pure `chip` that turns a state into the label's words. The Electron side
(`electron/updater.ts`) only feeds it events and sends each new state to the page; the page (`src/ui/UpdateChip.svelte`)
only draws it. It does not install anything, never restarts the app by itself, and never interrupts the user (no modal,
no OS notification). Readers: the chip and its popover, the job log lines that `updater.ts` writes from the same states.

Suite: `npx vitest run tests/update-state.contract.test.ts tests/updater.test.ts --reporter=junit --outputFile={junit}`

## Interface
- `initial(version, selfUpdating, packaged): UpdateState`; `step(state, event, now): UpdateState`;
  `chip(state, now, whatsNewVersion): Chip`; `CHECK_EVERY_MS` (4 h), `STALL_MS` (15 s).
- States: `dev`, `checking`, `current`, `downloading`, `ready`, `failed`, `manual`. Events: `checking`, `none`,
  `available`, `progress`, `downloaded`, `error`, `manual`. Times are epoch milliseconds, passed in, never read.

## Obligations

### Behaviour: states
- **US-01** A build that is not packaged and not self-updating starts as `dev`, and `dev` ignores every event. Every other
  start is `checking` with no last check (`checkedAt: null`). Why: a development run is not an installed version and must
  never claim to be up to date or offer an update. Kind: behaviour.
- **US-02** `ready` is sticky: `checking`, `none`, `error`, `progress` and a `manual` event leave it `ready` unchanged, and
  so does an `available` or `downloaded` for a version that is not newer than the one ready. Why: the downloaded update
  still installs when the app quits; a later failed or empty check must not take the offer away. Kind: behaviour.
- **US-03** From `ready`, an `available` with a newer `next` gives `downloading` of that version, and a `downloaded` with
  a newer `next` gives `ready` of that version. From any other live state `available` gives `downloading` (an `available`
  for the version already downloading keeps its progress) and `downloaded` gives `ready`. Why: releases ship several a
  day; the chip must offer the newest. Kind: behaviour.
- **US-04** A `checking` event keeps the last successful `checkedAt` (null before the first). `none` gives `current` with
  `checkedAt` set to now. While `failed`, `downloading` or `manual`, a `checking` event changes nothing. Why: "checked at"
  is the last time GitHub answered, never the time of an attempt; a retry must not erase how long checking has failed.
  Kind: behaviour.
- **US-05** `error` from `checking`, `current`, `downloading` or `failed` gives `failed` with the reason; `since` is the time
  of the first error of a run of errors (an error while already `failed` keeps `since`), and `checkedAt` is the last
  success (kept from the state it left, null from `downloading`). A later `none`, `available` or `downloaded` ends the run.
  `manual` and `ready` ignore an error. Why: "couldn't update since 7:56 AM" must say how long, not when the latest retry
  failed. Kind: failure mode.
- **US-06** `progress` updates the byte counts and the rate while `downloading`, and moves `lastDataAt` to now only when
  `transferred` grew; outside `downloading` it is ignored. Why: a stalled download repeats the same count; only growth
  is data. Kind: behaviour.
- **US-07** `manual` gives `manual` with the version, its link and `checkedAt` now (from any state but `dev` and `ready`).
  Why: a build that cannot update itself still tells the user where the new one is. Kind: behaviour.
- **US-08** `CHECK_EVERY_MS` is 4 hours, `STALL_MS` is 15 seconds and `STALL_ABORT_MS` 120 seconds. Why: releases ship up to ten a day, and a user must
  not wait a day to learn of one; 15 s is the stall time the app's other transfers use. Kind: compatibility.

### Behaviour: the chip's words (`X` the running version, `N` the next)
- **US-09** `dev`: `X · dev build`; `checking`: `X · checking…`; `current`: `X · up to date, checked <time>` with the time as
  `toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })`; when `whatsNewVersion` equals `X` a `current` state says
  `Updated to X · What's new` with action `whatsnew` and accent. None of the first three has an action or an accent.
  Kind: behaviour.
- **US-10** `downloading`: `Downloading N · <done> of <total> MB` (MB are bytes / 1e6, rounded; `Downloading N` while the
  total is not yet known); after `STALL_MS` with no new data: `Downloading N · no data for <s> s`. No action, no accent.
  Kind: behaviour.
- **US-11** `ready`: `N ready · Restart to update`, action `restart`, accent. `failed`: `X · couldn't update since <time>
  · Retry`, action `retry`, no accent. `manual`: `N is out · Download`, action `download`, no accent. `ready` and the
  What's new label are the only accented labels. Why: one thing at a time asks for the eye. Kind: behaviour.
- **US-12** Every state's `title` is a tooltip in plain words ending in a full stop, naming the versions involved (the running
  one, and the next where there is one); the `ready` title is `Hindsight N is downloaded. Restart now, or it installs the
  next time you quit.` Kind: behaviour.

### The updater (`electron/updater.ts`, tested through fakes of electron-updater and Squirrel.Mac)
- **US-13** An `install-failed` event (Squirrel.Mac's own error before it has staged the download) turns `ready` into
  `failed` with the reason; anywhere else it changes nothing, and a Squirrel error after staging is ignored. Why:
  electron-updater says "downloaded" before Squirrel has the update; if Squirrel then fails, neither Restart nor quitting
  installs it, and the chip must not say they will. Kind: failure mode.
- **US-14** `check()` starts nothing (and returns false) while a check is in flight, a download runs, or an update is ready.
  Why: a second check while ready downloads and hands the update to Squirrel again, and on Windows and Linux a failed newer
  download deletes the staged installer. Kind: behaviour.
- **US-15** A check with no answer in `CHECK_TIMEOUT_MS` (60 s), or one electron-updater answers with nothing, is `failed`,
  and a new check may then start. Why: the chip must never sit on "checking…". Kind: failure mode.
- **US-16** A download with no new bytes for `STALL_ABORT_MS` is cancelled and `failed`, the reason saying where it stopped;
  electron-updater's own "cancelled" error doesn't replace that reason; a gap between stall checks longer than `STALL_MS`
  (the computer slept) starts the wait again. Kind: failure mode.
- **US-17** Restart installs (`quitAndInstall(true, true)`) only from `ready`; on a Mac only once Squirrel has staged the
  update (before that: `preparing`); with a job running only when forced (else `busy`, the job's name). Why: asked before
  Squirrel has staged, electron-updater leaves a listener that quits the app whenever staging finishes, a restart nobody
  asked for at that moment. Kind: safety.
- **US-18** Nothing the updater does in reply to an electron-updater event throws back into it; a failure is logged. Why:
  the listeners run inside electron-updater's emit, before its install steps. Kind: failure mode.
- **US-19** An update never downloads while one of the user's own jobs runs (a pull, a Sync, a log download, a .hoot read,
  any job either runner holds): a release found then is `waiting` with the job's name (label `N waits for <job>`, no action,
  no accent); a job that starts mid-download stops it and the state is `waiting`; once no job runs, a fresh check starts
  the download. electron-updater's own "cancelled" error for that stop changes nothing. Why: the user's work comes first,
  above all on a weak connection (Kevin, 2026-11-09); a stopped update refetches only its changed blocks (about 5 MB, from
  the release blockmaps). Kind: behaviour.
