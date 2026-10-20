# AGENTS.md

Notes for coding agents working in this repository. `README.md` and `docs/` are for people.

This repository is public (since 2026-10-19). Nothing private goes into code, docs, fixtures or commit messages: no people's names or contact details, no private Slack or mail, no other team's name next to a criticism.

## Landing a branch

- After CI passes on a branch tip, land it with `git merge --no-ff` so the tested commits are the ones on main. If
  you must rebase, re-run every suite on the rebased result before pushing (165e7dd and 9875905 did).

## Rules (`src/rules/`)

- Rules are written for a high-school student to read and copy: follow CONTRIBUTING.md, "How a rule should read".
- A cleanup that must not change what a rule finds is proved, not argued: `npm run golden -- <out.json> <log
  folder> ...` before and after, then `cmp`. It records every finding, evidence value, plot and not-checked
  reason. Rules that never fire on the logs you have are covered only by the unit tests.
- A new rule adds a "not checked" entry, and one to meta/not-checked's count and evidence, on every log that
  lacks its keys, so golden can't stay byte-identical. Prove it adds nothing else: strip those from both runs and
  require zero residual differences per log (2026-10-20: 264 logs, can/device-rebooted).

## Session summaries (`src/session/`)

- Summaries are saved in the browser and shown after an update while their `SUMMARY_SHAPE` matches. Change `MatchSummary` so old copies can't be drawn: bump `SUMMARY_SHAPE` in `summary.ts` and update the key list in `tests/reread.test.ts`.

## Robot snapshot (`tools/robot-snapshot.py`, `src/snapshot/`, `src/ui/SnapshotView.svelte`)

- **The collector is read-only by construction, and the tests enforce it.** `_get()` is the only network call.
  `build_url()` refuses any action outside `ALLOWED_ACTIONS` (`getversion`, `getdevices`, `getsignals`,
  `getconfigv2`, `decoratedselftest`). Never add an action, and never call `blink` (it may clear sticky faults),
  `controlv2` (spins motors), `setconfigv2`, `setid`, `setname`, `setupdatefrequency` or `plotpro`.
  `tests/test_robot_snapshot.py` checks this with AST tests: one network call site, `subprocess` only in
  `run_local`, a fixed import set, and no forbidden action string outside docstrings.
- **No retries, no variations.** The first `GeneralReturn.Error ≠ 0`, timeout or bad answer stops the run. The
  partial snapshot is still written, and the exit code is 2.
- **Stdlib only, Python ≥ 3.8** (macOS ships 3.9). Students run it with no install.
- **Built files (Mac and Windows, Python bundled by PyInstaller) come only from
  `.github/workflows/robot-snapshot.yml`**, from committed source that passed the tests, with `BUILD` replaced by the
  git commit (`scripts/build-robot-snapshot.py`). `scripts/smoke-robot-snapshot.py` runs the built binary against
  the stub and fails unless every request is an allowed read and the build stamp matches. Never commit a built binary
  or zip (`dist-snapshot/` is ignored). Double-click mode (the team-number prompt and the "Press Enter" pause) runs
  only when frozen, with no arguments, on a terminal; `python3 tools/robot-snapshot.py` and tests behave as before.
  To cut a release: get Kevin's go, then push a tag `robot-snapshot-vX.Y.Z` on a tested commit; the workflow
  publishes both zips with their sha256.
- **owlet (CTRE's hoot converter) must never be downloaded, bundled, copied or committed** (CTRE EULA). The
  collector runs it in place from AdvantageScope's cache, picked by the hoot file's compliancy byte (offset 70).
- **Signal ids change between Phoenix versions.** Resolve sticky faults by name from `getsignals`, and configs by
  `SignalName`. Never hard-code an id.
- **Fixtures are synthetic.** The scenario is written by hand in `tests/robot_snapshot_fixtures.py`, from the
  response shapes of CTRE's 26.3.0 simulator. `fixtures/robot-snapshot/snapshot-*.json` are generated with
  `python3 scripts/make-snapshot-fixtures.py`; a test fails when they are stale. No real serial numbers, team
  names or paths. Real robot answers may become fixtures only with serial numbers stripped.
- **Foresight uses a snapshot, it never reads the diagnostic server itself** (`src/foresight/snapshot-checks.ts`).
  A person drops `snapshot.json` on the Foresight page; the page makes no request to port 1250. A snapshot counts
  only when taken at least 30 s after this run of the robot code started (the code applies its configs at start-up),
  on the laptop's clock; otherwise all five `snapshot/*` checks say "not checked" and the checklist lines never read
  OK. They stay amber whatever the proof table says, until a snapshot of our robot has been backtested and caught
  a real fault. `tests/foresight-snapshot.test.ts` also fails if any Foresight, snapshot or UI source names a write,
  blink or clear action.
- `responseShapes` in a snapshot says what the parsing was checked against (`"simulator"` until a real robot's
  answers have been compared). Until then, booleans are parsed leniently, and anything unparseable is shown as
  "unreadable", never read as false.

Tests:

```
python3 -m unittest discover -s tests -p 'test_*.py'             # collector (stub server, no robot)
HINDSIGHT_HOOT_DIR=<folder of .hoot files> python3 -m unittest tests.test_robot_snapshot.RealHootFiles
npx vitest run tests/snapshot.test.ts                            # Hindsight side
npx vitest run tests/foresight-snapshot.test.ts                  # Foresight's snapshot checks
npm run build && node --experimental-strip-types scripts/chrome-snapshot-check.ts <out-dir>   # rendered check
```

## Companion library (`companion/`)

- A Gradle build (JDK 17) of two vendordeps, `HindsightCompanion` (`core/`) and `HindsightCompanionBattery`
  (`battery/`). It logs only what nothing else logs. Don't add anything AdvantageKit, Phoenix's hoot or
  PhotonVision already logs.
- **Every key it logs is in `companion/keys.json`.** Java tests (`KeysTest` in each module) check the library logs
  exactly those keys; `tests/companion-keys.test.ts` checks the keys Hindsight reads are on the list. Change a key in
  all three places or not at all: Hindsight's profiles read the battery keys, and Foresight reads the log-drive keys
  (`LOG_DRIVE_KEYS` in `src/foresight/keys.ts`, for `foresight/log-usb-stick`).
- Hardware is read only on a real robot, and every read is an AdvantageKit input, so a replay reads it back. A failed
  read is logged, never thrown: the library runs inside someone else's robot code.
- The `/proc` fixtures in `core/src/test/resources/proc` are synthetic.

Tests:

```
cd companion && JAVA_HOME=<a JDK 17> ./gradlew build     # both vendordeps, their tests, build/vendordep JSONs
npx vitest run tests/companion-keys.test.ts               # the key list, Hindsight's side
```
