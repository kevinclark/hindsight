# AGENTS.md

Notes for coding agents working in this repository. `README.md` and `docs/` are for people.

This repository is public (since 2026-10-19). Nothing private goes into code, docs, fixtures or commit messages: no people's names or contact details, no private Slack or mail, no other team's name next to a criticism.

## Landing a branch

- After CI passes on a branch tip, land it with `git merge --no-ff` so the tested commits are the ones on main. If
  you must rebase, re-run every suite on the rebased result before pushing (165e7dd and 9875905 did).
- CI (`code-check-action`) runs only when `src/code/**`, `action.yml`, `scripts/code-check.ts` or `package*.json`
  change; a branch that touches none of them gets no run at all, so waiting for one never ends. Then run `npx vitest
  run` and `npm run check` on `git archive <tip> | tar -x` of the tip before landing (ad9ccd9, 2026-10-23).

## Rules (`src/rules/`)

- Rules are written for a high-school student to read and copy: follow CONTRIBUTING.md, "How a rule should read".
- A cleanup that must not change what a rule finds is proved, not argued: `npm run golden -- <out.json> <log
  folder> ...` before and after, then `cmp`. It records every finding, evidence value, plot and not-checked
  reason. Rules that never fire on the logs you have are covered only by the unit tests.
- A new rule adds a "not checked" entry, and one to meta/not-checked's count and evidence, on every log that
  lacks its keys, so golden can't stay byte-identical. Prove it adds nothing else: strip those from both runs and
  require zero residual differences per log (2026-10-20: 264 logs, can/device-rebooted).
- A session counts a quiet match as clean ("not seen since", src/session/stopped.ts), so a `check` whose early
  return means "this didn't happen in the match" (never enabled, not on the field, never moved) calls
  `match.couldNotCheck`, never a bare `return`. A rule for only some motors or groups declares `only`: an item
  that returns nothing counts as checked (2026-10-21: 12 rules changed, 264-log golden 0 residual).
- Read AdvantageKit's GitDirty only through `isUncommitted()` (`src/match/git-dirty.ts`), never a regex of your
  own: older AdvantageKit writes "Uncomitted changes" (one m), and `/uncommitted/i` missed 10 of 520 library
  logs (2026-10-22).

## Profile builder (`src/builder/`)

- Golden doesn't cover the builder. Prove a builder change by diffing `scripts/builder-backtest.ts` output (and a
  motors/groups survey) over every library and public log before and after; read every line that changed.
- Drafts from code (`code-motors.ts`, `code-draft.ts`) never guess: a folder pairs with the IO whose
  `updateInputs(inputs)` fills it, else the nearest chain; a tie, or a key two code motors claim, gives nothing.
  Score with `builder-backtest.ts --code <clone>` on every robot, the 2026 logs included (2026-10-22: a shared
  outer chain gave all four drive motors ID 6, caught only on 2026).

## Plain-node scripts

- `src/version.ts` imports `package.json`, which plain node (`--experimental-strip-types`: golden, check, scripts) can't load without a JSON import attribute. Code those scripts reach (rules, coverage, session) must not import it, even through `src/report/review-model.ts`; shared report helpers go in their own file (`src/report/repo-paths.ts`).

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

## Gradle plugin (`companion/gradle-plugin/`)

- Plugin id `io.github.kevinclark.hindsight`, applied by a team's robot `build.gradle`. It runs inside their Gradle
  (8.11 with JDK 17 for WPILib 2025 and 2026), so it targets Java 17 and reaches GradleRIO only by reflection
  (`WpilibNatives`): never add a compile dependency on one GradleRIO year.
- **Error Prone's patch mode runs only the checks it patches** (measured: 5 warnings instead of 71). Never add
  `-XepPatchChecks` to `compileJava`; the fixes run in their own compile (`AutoFix`), only when
  `compileJava` warned, and never when a GradleRIO deploy task is in the graph or `CI=true`. A deploy is
  recognised by task type (`edu.wpi.first.deployutils.deploy.*`), never by name: robot projects carry an
  `eventDeploy` task that runs on every build.
- Error Prone is an allowlist (Kevin, 2026-10-21): all warnings off, then the alerts and tidy checks in
  `ErrorProneChecks`. NullAway is opt-in (`nullAway = true`): on one robot its 11 warnings held 0 bugs. Adding a check
  to either list changes what every team sees; measure it on robot code first.
- `HindsightRobotStarts.java` is a resource, compiled against each robot's own WPILib by a `JavaCompile` of its own
  (a source set would put it in front of the team's Spotless and Checkstyle). Keep its traps: the real
  loop in a thread (`startCompetition`), the DS connected after the robot is built, one robot per JVM, and
  `DriverStationDataJNI.notifyNewData()` (never `DriverStationSim.notifyNewData()`, which deadlocked). It runs as a
  `JavaExec` with output to a file, because Phoenix and the HAL print natively and a `Test` task can't hold that back.
- Test: `cd companion && JAVA_HOME=<a JDK 17> ./gradlew :gradle-plugin:test` (TestKit). The robot-starts check is
  tested only on real robot projects; `companion/gradle-plugin/README.md` has the init script for that.

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
- Reading a team's CTRE device: get each signal with `getX(false)` and `.clone()` it. A plain `getX()` looks the
  signal up again with errors reported and refreshes the team's own cached object. Read clones with
  `refresh(false)`: `BaseStatusSignal.refreshAll` prints "CAN frame not received" to the DS console for every
  missing signal (9 lines per device at boot, seen in CTRE's simulator).
- Phoenix's reset flag (`getResetOccurredChecker()`) also fires with a device's first answer after start-up
  (`hasUpdated()` is true on the first valid timestamp): count a reboot only when the device was already answering.
- Phoenix code can't run in companion's own tests (no natives). To exercise it, put a test in package
  `com.frc8033.hindsight` inside a WPILib robot project (GradleRIO sets up the simulator) built against the
  published companion jar; `HAL.initialize(500, 0)` first.

Tests:

```
cd companion && JAVA_HOME=<a JDK 17> ./gradlew build     # both vendordeps, their tests, build/vendordep JSONs
npx vitest run tests/companion-keys.test.ts               # the key list, Hindsight's side
```

## sim-run (`scripts/sim-run.ts`, `src/simrun/`, `tools/sim-run/SimRunHarness.java`)

- **Never touch the team's folder.** The code is copied (`git ls-files -co`, or `git archive` for `--commit`) into
  the OS temp folder and built there: `simulateJava` runs `spotlessApply`, which rewrites source.
- **No HAL extension, no robot-repo edit.** sim-run builds with `simulateExternalJavaRelease` and starts the jar
  itself with `HALSIM_EXTENSIONS` unset. The harness drives the DS through `DriverStationSim` and must notify with
  `DriverStationDataJNI.notifyNewData()`: `DriverStationSim.notifyNewData()` also runs `DriverStation.refreshData()`
  on the harness thread and dead-locked the robot loop (measured). The NT log uses `DataLogBackgroundWriter`; a
  synchronous `DataLogWriter` stalled the robot loop inside NetworkTables (measured).
- **The harness is compiled against each robot's own jar** (`--release 11`): `Command` is an interface in 2022 and a
  class from 2024, so a prebuilt class breaks on the other years. Calls that differ by year go through reflection.
- **About one run in six aborts in native code after `end`** (57 of 331 runs) (`libc++abi: ... mutex lock failed`, a macOS crash
  report at most): WPILib's or a vendor's shutdown, measured with both `halt()` and `exit()`. Nothing is lost: the log
  is closed and `end` printed first. Don't read it as a crash; the crash check never does.
- **A crash is a missing `end` line plus WPILib's "Unhandled exception" text**, never the exit code: `RobotBase`
  exits 0 after an exception.
- Fixtures in `tests/simrun.test.ts` are made-up harness lines. Runs against real robot code are 8033's backtest, not
  CI: Phoenix sim runs in real time.
