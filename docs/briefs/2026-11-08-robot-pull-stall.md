# Robot pull: never stall silently, never start over, always say what is happening

Repo is public: nothing private in code, docs, fixtures or commit messages. No team named beside a criticism.

## What happened

At an event a robot pull (Library → pull from robot, `hub:addFromRobot` in `electron/hub-ipc.ts`) was tried about six
times. Each time it stalled; the last sat on "Pulling logs off the robot · 33 of 70" indefinitely. Nobody could tell
whether data was moving. Nothing was logged, so there is nothing to diagnose from.

Two causes in the code:

1. `connectRobotFs` (`src/hub/robot.ts`) sets no SSH keepalive, and `download` has no inactivity limit. A link that goes
   quiet mid-file (radio, Wi-Fi, tether) never errors: the read stream waits forever.
2. `ingestWork` (`electron/hub-ipc.ts`) writes `seen.json` only after the whole ingest. A stalled or stopped pull
   remembers nothing, so every retry downloads files 1–32 again (they are already in the library, found by sha only
   after the download) and meets the same stall.

## Obligations (name tests by id, e.g. `it('P1: ...')`)

Robot transfer (`src/hub/robot.ts`):

- **P1** SSH keepalive on: `keepaliveInterval: 5000`, `keepaliveCountMax: 3`, so a dead link is noticed in ~15 s.
- **P2** A download that receives no bytes for `STALL_MS` (15 s, exported constant, injectable in tests) fails with a
  `Stalled` error whose message says how long and at how many bytes ("no data from the robot for 15 s, at 41.2 of 88.0 MB").
  A connection close/end during a download fails it too (it must not hang).
- **P3** A `list` (readdir) that does not answer within `STALL_MS` fails the same way (listing must not hang either).
- **P4** On a stall or connection loss mid-file, the pull reconnects (same address, 10 s connect timeout) and **resumes
  the file from the bytes already written** (`createReadStream(remote, { start })`, local file opened for append), up to
  3 tries per file in all. Each retry shows as the job step in words: "Robot stopped sending; reconnecting (try 2 of 3)".
  The file's byte bar keeps its bytes across a resume (does not drop to 0).
- **P5** After the last try fails, the whole pull stops (not just that file: the link is gone, and trying 37 more files
  at 3 × 15 s each would be another silent wait). The result says, in words: which file (n of N and its name), why,
  how many logs are now in the library, and "Pull again to continue from here". Implement as an error class ingest
  treats like Stop (break, `report.stopped`), with a `report.lostLink` reason; do not record the file as unreadable and
  do not write an `unreadable:` seen entry for it.
- **P6** Stop still works at every point: during a stall wait, during a reconnect, during a resume.
- **P7** The size check after a download (`got !== e.size`) still applies after a resume.

Lost progress (`electron/hub-ipc.ts`, `src/hub/ingest.ts`):

- **P8** The seen memory is written to `seen.json` after **each** file, not only at the end, so a stall, Stop, crash or
  quit at file 33 leaves files 1–32 known and a retry starts downloading at 33. (Suggested: an awaited
  `afterEach` hook in `IngestOptions`; any shape that is tested is fine.) Writes are atomic (temp + rename) if the
  existing `writeJson` is not.

Feedback (`src/ui/JobBar.svelte`, `src/ui/job-bar.ts`, used by every job: robot pull, Sync, Download, folder add):

- **P9** While bytes are moving, show the transfer speed beside the amounts: rate over the last 5 s, formatted
  "1.4 MB/s" / "320 kB/s" (pure function in `job-bar.ts`, unit-tested).
- **P10** When no bytes have moved for 3 s or more during a byte-counted file, replace the speed with
  "no data for N s" (seconds counting up, once a second, from a timer in the component, since no progress events
  arrive while nothing moves) styled as a warning (existing warning token/colour; not red). It returns to the speed as
  soon as bytes move. Not shown while a file is being read locally with no byte count, nor in a step with no file.
- **P11** The step words of P4 show in the bar's head, so a reconnect is visible.

Log (`electron/`, new small module):

- **P12** Every job appends timestamped lines (ISO time with offset) to `<userData>/logs/jobs.log`: job start (name,
  app version), each step change, each file start (n of N, name, size) and end (outcome, bytes, duration, average
  rate), each stall, reconnect and resume (offset), errors with message, and the job's finish (report summary or error,
  stopped or not). Byte-progress events are not logged (too many). Rotate at 5 MB to `jobs.1.log` (keep one).
  Hook it in `JobRunner`/the `job()` wrapper and the robot transfer, not per call site.
- **P13** The finished-job card in `LibraryView.svelte` (and wherever the robot pull result shows) has a
  "Show log" button that reveals `jobs.log` in Finder/Explorer (`shell.showItemInFolder`), via a new IPC handler.

## Checks the implementation must pass

- A **real SFTP stall test**: start an `ssh2` `Server` in the test (127.0.0.1, random port, host key generated in the
  test, accept user `lvuser` with an empty password / keyboard-interactive) that serves an SFTP file and, on demand,
  stops sending mid-file (holds READ requests unanswered) or drops the TCP connection. Prove against it: P2 (stall
  detected at the injected `STALL_MS`, e.g. 500 ms), P4 (reconnect + resume gives a byte-identical file; the server
  sees a READ starting at the resume offset), P5 (server that never recovers → pull stops with the words), P6 (Stop
  during a stall resolves promptly), P3 (readdir held unanswered). `connectRobotFs` takes its address as
  `host:port` or needs a port option for this; keep the robot default port 22.
- Unit tests for P8 (seen written after each file: stop the ingest at file 2 of 3 and read seen.json), P9/P10 pure
  functions, P12 log lines (inject a clock).
- `npm run verify` (or the repo's full check: `npx vitest run` with `HINDSIGHT_TEAM_LOGS=/nonexistent.json`,
  `npx svelte-check`, lint) green in this worktree.
- Render the JobBar states (moving with speed, "no data for 7 s", reconnecting step) and screenshot them; put the
  screenshots outside the repo in `~/code/makers/hindsight-ux-shots/2026-11-08-pull-stall/`. A Svelte text node that
  starts with a space drops it: use `{' '}`.

## Commits

On branch `claude/robot-pull-stall` in `~/code/makers/hindsight-wt-pullstall`. Do not push and do not merge to main
(main is a public release). The user-visible commit gets a `Changelog:` trailer in the same last paragraph as
`Co-Authored-By:`, plain words, e.g. "Pulling from the robot shows the transfer speed and says when no data is
arriving; a stalled pull reconnects and resumes, and a retry picks up where the last one stopped."

## Unspecified by design

Exact layout of the speed/no-data text within the existing meta line; log line format beyond the fields listed.
