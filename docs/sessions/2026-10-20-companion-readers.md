# 2026-10-20: readers for the companion's device and hoot keys

## Handoff

- leftovers:
  - `focus add "Hindsight companion readers: follow-ups" --project hindsight --next "1) hoot line reads the companion's Status only at the stretch end (an unavailable start reads as not recording); 2) hoot line missing from Foresight's exported report (ForesightReportInput); 3) Foresight could subscribe to the profile motors' Device keys for an exact live join (+19 topics, live test caps at 120, now ~108); 4) the wanted check 'Did every CTRE device report a good status within a few seconds of boot?' may now be partly coverable from the companion's Connected/Status; 5) on the first real robot log: check Version byte order (shown with raw hex), the diagnostic server's CANbus string for a named CANivore vs the companion's bus label, and Status strings when a device is off the bus" --session local_b59941c8-2a4c-4f76-9365-1479f8c4f9e7`
- repos:
  - hindsight (`/Users/kev/code/makers/hindsight/.claude/worktrees/xenodochial-perlman-8c3532`, branch fast-forwarded to origin/main c470056): stage `docs/sessions/2026-10-20-companion-readers.md` and `AGENTS.md`; message "Session note: companion device/hoot readers (merged c898ac2); AGENTS.md: a new rule can't leave golden byte-identical"; push `HEAD:main` (fast-forward only).
- lessons:
  - target: `project` (hindsight `AGENTS.md`, section "## Rules (`src/rules/`)", as a new bullet after the golden bullet). Text:
    "- A new rule adds a \"not checked\" entry, and one to meta/not-checked's count and evidence, on every log that
      lacks its keys, so golden can't stay byte-identical. Prove it adds nothing else: strip those from both runs and
      require zero residual differences per log (2026-10-20: 264 logs, can/device-rebooted)."
    Evidence: this note, "Golden".
  - target: `skill code-standards § proving a cleanup changed nothing`. Text:
    "When a change must add only known entries (a new rule's skip line, a counter), strip exactly those from both
    golden runs and require zero residual differences, log by log; report the count of each stripped addition. A
    bare `cmp` failing tells you nothing, and an eyeballed diff misses the second change (Hindsight 2026-10-20: 264
    logs, 264 identical skip additions, 0 residual)."
    Evidence: this note, "Golden".
- focus: `done session:local_b59941c8-2a4c-4f76-9365-1479f8c4f9e7 --why "Hindsight + Foresight checks for companion device keys: readers built, two reviews folded, branch a309642 merged to Hindsight main as c898ac2 (2026-10-20 afternoon PDT); follow-ups filed as their own focus item"`
- verified: `git fetch`; a309642 is an ancestor of origin/main (8fca004 at the check, c470056 after the fast-forward); worktree clean before this note. Tests on a309642: vitest 667 passed / 2 env-gated skips, svelte-check 0/0, companion `./gradlew build --rerun-tasks` (JDK 17) successful. Nothing deployed; nothing has run on a robot.

## What was built

Readers for `/Hindsight/Devices/<bus>/<model>/<id>/*` and `/Hindsight/Hoot/*` (companion/keys.json):
`can/device-rebooted` (new, `forEach: 'watchedDevice'`); `can/device-dropout` over devices only the companion watches;
Foresight `foresight/sticky-faults`, `foresight/firmware-mismatch`, a "CTRE devices healthy" checklist line, and a
snapshot join (`sameModel`, `snapshotBusFor`, `snapshotDeviceFor`, `joinWatched`); the Logging tab's "Device key"
lines for motors whose IO logs no `Device` key; a hoot context line (Logging tab and Foresight page); the builder
reads `<path>/Device` as the CAN ID. Shared code: `src/match/companion.ts`.

Decisions worth knowing: a watched device takes the profile's name exactly through the IO's `Device` key, else by
model and CAN ID only when one watched device matches. Foresight subscribes to `/AdvantageKit/Hindsight/` by prefix
(device keys can't be listed ahead); the live test now pins exactly that one prefix. All new Foresight checks are
amber (not in proven.ts).

## Golden

264 local logs (the team's 2026 event, four hindsight-test folders, three loose logs from it). With each log's
can/device-rebooted skip entry and its meta/not-checked line and count stripped, before and after are identical on
every log (0 residual differences); the skip was added on 264 of 264 logs, since none has the companion's keys.

## Reviews

Fable reviewer and code-review high (13 findings, graded by Fable): fixed the bus-blind twin join, the 1 s "together"
window against the companion's 1 s reads, a reboot counted at a read where the device wasn't answering, "not read"
(simulation/replay) readings taken as drops, misfit profiles skipping companion-only devices, watch lines sorting
above match-guarding gaps, snapshot duplicates, and the field-name list. Two efficiency findings judged not real.
