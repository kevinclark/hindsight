# Hindsight

Lints FRC team 8033's robot match logs in the browser. A student drops a match's `.wpilog` (and the Driver Station
`.dslog`, if they have it) onto one HTML page and gets a lint report, worst first, and a power view for brownouts.
Nothing is installed and no file leaves the computer. Named after `#in-hindsight`: every problem we learn the hard way
becomes a rule that checks every later match for it.

Phase 1 of the design in `8033/robot/hindsight-proposal.md` (decisions) and `hindsight-research/design-detail.md`
(detail), built to `8033/robot/hindsight-build-brief.md`.

## Use it

- **Offline (events):** copy `hindsight.html` to the laptop you review and check from (a pit laptop; teams that keep
  the drive laptop for driving only, as 8033 does, copy the `.dslog` off it) and double-click it. Works from `file://`.
- Drop one or more `.wpilog` files, plus `.dslog` files. A DS log is matched to the robot log it overlaps on the wall
  clock; one from another match is reported and ignored.
- **Match** tab: findings, worst first. Each shows its evidence numbers, a plot of the moment, what it might mean,
  the next step, the possible causes (each with what to look for and where; the ones this log points to first, any it
  rules out struck through), and why the rule exists. Advice knows what you loaded: with the `.dslog` in, it says
  what the DS log shows rather than asking for it. "Not checked" lists rules that couldn't run on this log.
- **Switching views** (Match review, Session, Limits wizard) keeps everything loaded in each. A **reload** keeps the
  Session: each log's summary (never the log) is saved in this browser, keyed by file name, size and modified time,
  and restored with a note and a "Clear saved copies" control. After a Hindsight update the old summaries are still
  shown, marked as read with an older Hindsight; **Read again** (in the session's header) reads that session's logs
  again with the new one (it asks for the folder if the page no longer has the logs) and lists which findings are new,
  gone, or changed. **New session** clears the summaries on the page and in this browser; moved logs, session names,
  battery ids and known-issue marks are kept. Opening a restored match in Match review asks for its file again. A
  private window, or a browser that blocks storage for pages opened from disk, just doesn't save (the page says so).
- **Times** read in match time first, robot time in parentheses ("1:47 into the match (teleop; robot time
  532.8 s)"), and plots are labelled in match time; robot time is what AdvantageScope shows.
- **Power rules** besides brownouts and battery health: `power/main-breaker-margin` (the 120 A main breaker heats
  with current²; its load is the root of an exponential average of total current², τ = 90 s, against the 100–130 %
  band where it trips, with the 30 s and 180 s figures alongside, since the datasheet curve is only read by eye) and
  `power/pd-not-reporting` (the power distribution board logged no channel currents while the motors drew current;
  it says which board type the log claims from the channel count: 24 = REV PDH, 16 = CTRE PDP). The robot profile
  names the board (`powerDistribution`): a warning when it is one that can report (REV PDH, CTRE PDP), context when it
  is a CTRE PDP 2.0, which has no current telemetry, or when the board is unknown.
- **Power** tab: lowest voltage and margin to the brownout setting, the loads at the deepest sags, the battery's
  estimated open-circuit voltage against charge drawn, and flywheel current-cap what-ifs with the model's error.
- **Logging** tab: which signals the checks need that this log is missing, as a to-do list. See
  [Logging what the checks need](#logging-what-the-checks-need).
- **Download for Claude** saves `<log>.findings.json` (schema `hindsight.findings/2`: each finding has robot time,
  match time, meaning, ranked causes and next step): findings, evidence, summary
  statistics, short data windows and the fitted battery model. It never includes `/RadioStatus/*`, which carries a
  hashed Wi-Fi key.

- **Save for Slack** (beside each Download for Claude, in Match review and Foresight) opens the print dialog on a
  report layout, not on the app: page 1 is the bottom line, each error with its one number, next step and plot, then
  warnings and info one line each; later pages hold what each error might mean, its causes and why the rule exists.
  Pick **Save as PDF** in the dialog (the file is named `<log>.report`). The same click saves `<log>.card.png`, a
  1080 px phone card (verdict or counts, each error's title and one number, the build with an uncommitted flag, type
  32 px or more) to post as the Slack image, with the PDF attached. Print is always light, whatever the screen is.
  Foresight's report is one page stamped with the time read, so a withdrawn verdict prints as NOT CHECKED, never GO.
  The Session view has the same button: page 1 is the match count, a bottom line, the merged findings with their
  confidence in words ("Consistent", "3 of 3 where it could be checked", the measured range and its line), the trends
  as small multiples with each number's verdict (battery identity is a letter, not just a colour) and the notes; page 2 is the rule × match grid.
  The card is `<label>.session-card.png`, the PDF `<label>.session-report.pdf`.
- **From the command line**, for Claude or a script: `node --experimental-strip-types scripts/report.ts <out-dir> <log>
  [<dslog>] [-- <log> …]` builds first (`--no-build` skips), drives headless Chrome on `hindsight.html` and writes
  `<log>.report.pdf`, `<log>.card.png` and `<log>.findings.json`. `scripts/chrome-foresight-report-check.ts <out-dir>`
  replays log C and log A as the robot's NT4 stream and writes the Foresight PDFs and cards.
  `scripts/report.ts --session <out-dir> <log|folder> …` loads them into the Session view and writes, per session,
  `<label>.session-report.pdf`, `<label>.session-card.png` and `<label>.session-findings.json`.
- **Ctrl+P** in Match review (any tab) also prints the report, not the app. What the report and card carry out of the
  laptop: the log file names, the build sha and branch, any notes students wrote in the team's history file, and in
  Foresight the robot's address and the controller names as read.

## Which robot a log is from

Rules never name a log key or a current limit; they ask the log's **robot profile** (`src/profiles/`). A profile is
one robot's code at one point: the log keys, motor groups and current limits as written on a branch, at a commit
(`code: { repo, branch, sha }`). One robot can have several, e.g. one pinned to `main` and one to the branch it ran
at an event, because limits change during an event.

Each log is matched to a profile by what it says about itself (AdvantageKit metadata):

1. the code's name for itself (`/RealMetadata/Codebase`) and the branch it ran (`/RealMetadata/GitBranch`);
2. the same robot pinned to another branch, with a note that limits may differ;
3. otherwise the profile with the most of its signals in the log.

When the chosen profile has under 60 % of its signals in the log, it doesn't fit (another robot, or another year's
code): the rules about specific motors, devices, cameras and mechanisms are listed as not checked, and auto and
teleop lengths are measured from the log.

The page shows which profile each log used and why, and **use…** (Match review) or **Robot for this session**
(Session view) picks another; the choice is kept in this browser. Findings that compare against the code say which
commit they read ("as of event-x d339f29; this log ran 45e3eba"): a log run before the branch's last commit may have
had different limits.

**Choose code folder…** (Match review and Session view) takes your clone of the robot code. For a log that ran another
commit than its profile's, power/limit-not-applied then reads each motor group's limit file at both commits straight
from `.git` and compares the lines that mention `CurrentLimit` (as `git diff -G'CurrentLimit'` would; values are never
parsed). The same lines: the log counts as the profile's code (a limit switched off in code is amber). Different: it
stays red, and the evidence lists the lines. Can't tell (a shallow clone, a commit you haven't fetched, a worktree's
`.git` file): red, with the reason. Without a folder nothing changes. Only the `.git` files needed are read; nothing is
changed or uploaded. Chrome and Edge remember the folder between visits (a click allows it again); other browsers ask
each visit. Each answer is kept per (repo, profile commit, log commit, files): in this browser, and for the scripts in
`~/.cache/hindsight/limit-lines.json` (`scripts/golden.ts` and `scripts/report.ts` take `--code <folder>`). Only the
lines in the files a group's `where` names are compared: a limit set through a name defined in another file
(`= Constants.KICKER_LIMIT`) isn't followed, so a change there reads as "the same" (every CurrentLimit line in the
2026 competition code is a literal).

**Use GitHub…** (beside it, and in Robot profile) reads the same code from a public GitHub repo instead of a folder:
type `owner/repo@branch` (pre-filled from the robot profile's repo). The comparison still reads the profile's pinned
commit and each log's own commit; the branch only says where Robot profile starts. Public repos only: nothing is signed
in and no token is sent, so a private repo answers "no public repo" and the folder is the way. GitHub allows **60
lookups an hour per network** without signing in, and a venue's Wi-Fi may share them: each commit costs about one (its
file list, kept in this browser by commit, so a second visit costs none), a branch name one more; file text comes from
`raw.githubusercontent.com` and doesn't count. The 8 logs of one 2026 event took 9 lookups the first time, 0 after. When the
hour's lookups are used up, or the laptop is offline, the finding says so (with the time it resets) and stays red: choose
the folder. If the hourly limit ever runs out in real use, the planned fix is to read each commit's file list from
jsDelivr (`data.jsdelivr.com/v1/packages/gh/owner/repo@<full sha>?structure=flat`, which allows `file://` pages and
listed the same 84 files at cb68b20 on 2026-10-20), leaving GitHub's API only to turn a branch name into a commit.
jsDelivr can't resolve a branch and may serve a branch's files stale, so it would only ever be asked for full commit
hashes. Not built: no real use has hit the limit yet. The page can't clone the repo itself, because GitHub's clone
endpoint and zip downloads don't allow calls from web pages. One source is in use at a time; choosing either replaces
the other. The scripts take `--github
owner/repo[@ref]` (`golden.ts`, `report.ts`), keeping GitHub's file lists in the same cache file.

To add a robot: **Robot profile** drafts one from your logs, a robot snapshot and (optionally) your code folder, and keeps it in the browser or saves a `profile.json` (`docs/robot-profile.md`; code in `src/builder/`). A built-in profile is a TypeScript file in `src/profiles/`, listed in `src/profiles/index.ts`.

### Robots without AdvantageKit

Each type of log is a signal map in `src/profiles/` (`advantagekit.ts`, `datalogmanager.ts`, `doglog.ts`), listed in
`src/profiles/formats.ts`: where that type keeps the signals every robot has. A signal may name several places in
order, and each match uses the first its logs have (`src/profiles/sources.ts`); one of them can be the Driver Station
log (`dslog:brownout`) or its event log (`dsevents:brownoutCount`, read by `src/readers/dsevents.ts`: the DS's own
brownout count, the FMS's match identity, and the roboRIO's kernel USB lines that `can/usb-dropout` reads), and a
finding that used one says so under "read from". The event-log facts were read from one robot's three matches only. Rules ask for signals by name and never
see which type of log it is, so reading a new type of log takes its signal map and a team profile.

A plain WPILib log (DataLogManager) works too. The match comes from `DS:enabled` / `DS:autonomous` and
`NT:/FMSInfo/*` (event, match type and number, and the FMS- and DS-attached bits of `FMSControlData`), whatever the
profile; `src/profiles/datalogmanager.ts` lists every key such a log can supply, and a profile starts from it. Two
kinds of key reach inside an entry:

- a **struct field**: the struct entry's name, `/`, then the field, e.g. `NT:/Telemetry/hood/motor/` + `supplyCurrent`.
  The layout comes from the log's own `/.schema/struct:<Type>` entry, so any team's struct decodes (nested structs and
  bit-fields included);
- a **bit** of an integer entry: `NT:/FMSInfo/FMSControlData:bit4`.

A profile leaves a key it can't fill as `''`, and rules that need it say so under "Not checked". A measured signal
(battery voltage, motor current or speed) logged slower than 30 times a second while enabled gets a note on each
finding that read it, since a short dip can fall between samples. The worked examples are three other teams' 2026
robots, read from their public logs: `frc340-2026.ts` (a TalonFX status struct per motor, no battery voltage),
`frc3602-2026.ts` (dashboard battery voltage at ~17 Hz, no motor currents) and `frc334-2026.ts` (a DogLog log,
`doglog.ts`: the roboRIO's readings and a REV PDH under `/Robot/SystemStats`; the PDH's total current stands in for
the motors', lined up with the voltage first). With no brownout flag in the robot log, the brownout rule counts the
Driver Station log's.

## Session view: many matches at once

**Session** (top of the page) takes a whole folder of logs (an event, a practice day). Each log is read and boiled
down to a small summary, then dropped, so hundreds of logs fit: 160 logs (53 MB each) took 24 s in Chrome on an
M5 Max (147 ms per log); the page never stopped responding for more than about 0.2 s. The JS heap peaks around
220–240 MB while a log is being read; the summaries themselves are about 10 KB each.

- **Sessions**: matches on the field with the same event name within 4 days are one event (when the Driver Station
  logged no event name, on-field matches within 4 days of each other are); other logs are grouped by the day they
  were played. One match recorded in several logs (the robot program restarted during it: same match label, starting
  within 30 minutes) counts once, with a note. The session says which robot profile its logs used; when none fits a log
  (under 60 % of its signals present), the rules about specific motors, devices, cameras and mechanisms are listed as
  not checked, and the match's auto and teleop lengths are measured from the log (on the field, auto is the time from
  auto start to teleop start less the field's 3 s pause). The date comes from the robot's clock, or, when the clock wasn't set (a roboRIO 2
  that was never set reads 2024-12-18), from the AdvantageKit file name, with a note; logs with neither go to "Logs with no date". Move a log to
  another session or rename a session from the page.
- **Findings across the session**, merged by issue: how many of the matches it could be checked in it fired in, a
  95 % confidence interval (Wilson) for that rate, the range of the measured value and how far past the rule's
  threshold it went. In words: **consistent** (most matches, at least 3 checked), **intermittent** (some, or every
  match of only 2 checked), **once**,
  or **not enough data** (under 2 matches checked). A fixed known issue that fires in a later match shows as "came
  back after a fix".
- **Rule × match grid**: fired, quiet or not checked, per match. Click a match to open it in Match review.
- **Per match** a verdict table, one row per number, worst first: lowest voltage, time under 7 V, charge, battery +
  wiring resistance, seconds a follower ran more than 15 % off its leader, auto loop overruns, vision outliers. Each
  row says the verdict ("Under 7 V in 8 of 8 matches"), draws a sparkline (the line as a hairline, one amber dot on the
  worst match), and quotes the rule's own next step. Dots are coloured by battery ID when there are any (logged, or typed in).
- **Download for Claude** saves `<session>.session-findings.json` (grid, confidence, per-match numbers).

Not used in the session view: Driver Station logs (match review only).

## Current limits (phase 2)

Built to `8033/robot/hindsight-phase2-limits-brief.md`. **The tool never writes or changes robot code or motor
settings**: it tells students what to set and which line to change, and they do it.

- **Limits tab** (Match review, any match log): each motor group's configured stator and supply limits (and whether
  the code switches them off, which removes Phoenix's default 70 A supply / 120 A stator limit), the lower limit and
  time (Phoenix defaults when the code doesn't set them), and what the log shows per motor: peak, p99, time more than
  5 A over the limit, the longest burst (≤ 0.2 s is the limiter catching up), and time at the limit. Plus a what-if
  for one group's supply limit (the Power tab's model, with its error), the robot current budget on the weakest
  fleet battery, and the hard-stop zeroing check.
- **Limits wizard** (top of the page): a supply-limit sweep the students run with the robot. Pick the mechanism, then
  for each limit: set it in Phoenix Tuner X, run 3 spin-ups from standstill, drop the log in. It measures each run,
  checks the limit took effect on every motor, flags runs that can't be compared, and recommends the limit at the knee,
  with the code line to change and a final read-back check. Progress saves to `limits-session.json`.
  The recommendation comes as a **burst / sustained pair** (Phoenix 6 `SupplyCurrentLimit`, then
  `SupplyCurrentLowerLimit` after `SupplyCurrentLowerTime`): the burst cap is checked against the battery budget, and
  the sustained caps of the groups that run together (from the loaded match) are added up against the 120 A main
  breaker (a slipping push), and so is a pinned push (stalled drive motors draw about stator² × R ÷ 12 V each, which
  only the stator limit governs when it stays under the sustained cap). It says plainly not to raise a burst cap above today's until the robot code sheds load as the battery
  voltage falls.
  The drive wheel-slip test is shown but locked until Kevin agrees the procedure.
- `scripts/limits-reference.ts` recomputes the Part A numbers a second way: the method of
  the earlier Python limit check (5 ms hold-last grid, more than 5 A over the limit),
  applied to supply current. It shares the app's .wpilog reader, so it checks the interval maths, not the decoding;
  the comparison with the brief's Python-derived numbers covers decoding. Flywheel leader over 45 A: app 6.09 / 6.83 /
  6.75 s, reference 6.11 / 6.85 / 6.76 s, brief 6.06 / 6.80 / 6.72 s (log A / log B / log C); the 0.03–0.05 s differences are
  the grid and the enabled-time window.

### Where this differs from the brief (and why)

- **"Did the limit take?"** (redesign accepted 2026-10-19) The brief judges the most common 2 A bin of samples ≥ 30 A against ±10 % of the limit. On
  real 2026 spin-ups that check fails both ways: at 60 A the mode is 33–39 A (the motor rarely needs 60 A), and
  a follower whose 40 A limit wasn't saved has a mode of 35 A while peaking at 73 A. Per motor the wizard says:
  **didn't take** (more than 0.3 s above 110 % of the limit; a working 2026 limiter stayed above for up to 0.21 s),
  **held at the limit** (mode within ±10 %, the brief's check; the drive's real 40 A plateau, mode 38–40 A, passes),
  **never had to hold** (never above 110 %), or **can't tell** (above it only briefly, which a working limiter also
  does). On those 2026 spin-ups, 60 A and 50 A steps are "can't tell" whether or not the limit was saved, so those
  steps are plotted but left out of the recommendation until a run confirms them; the comparison with the no-limit
  step (lower peak, smaller dip) is what shows them working.
- **The recommendation** walks down from the highest limit and stops at the first one that is too slow, so a noisy
  low step can't win.
- **Runs 5 s apart** won't start from a standstill: the 2026 flywheel took more than 5 s to coast down (45 → 7 rot/s
  in 5 s). The run card says to wait until the wheel stops (about 10 s).
- **Spin-up time** is to within 10 % of the target speed: holding speed, the flywheel ripples ±5 % around its setpoint.
  With that, log A/B/C spin-ups from standstill take 0.74 / 0.74 / 0.65 s (median), matching the earlier analysis's
  0.5–0.8 s. Only 7–13 spin-ups per match start from standstill (the analysis counted 15–27 of all kinds).
- **Shot recovery** (the match version of spin-up time) counts dips below 85 % of the target lasting ≥ 0.1 s: only
  0–3 per match, so treat it as a rough number until checked against video.

### To verify on the robot (unverified until a run confirms each)

- The took-effect check is only decisive where the no-limit run goes over 110 % of the limit for more than 0.3 s
  (on the 2026 spin-ups: 40 A and below). The first real sweep must confirm it at 60 and 50 A.
- A limit set in Phoenix Tuner X holds while the robot code runs, until the next boot.
- It applies the same way to the followers (CAN IDs 16–18) as to the leader (15).
- `SupplyCurrentLowerTime = 0` disables the step-down to the lower limit during the sweep.
- After the final code change, the read-back in Tuner X matches the code (`apply()`'s result isn't checked in code).
- The bench model in the tests (spin-up slows by the current ratio; battery = 12.6 V − 11 mΩ × current) predicts the
  real sweep. It only exists to exercise the wizard; the real numbers come from the students' runs.
- The drive wheel-slip test procedure (not runnable until Kevin agrees it).

## Logging what the checks need

A check can only look at what the robot logged. Hindsight says what is missing, so a team can add it before the match
where it matters.

- **Logging tab** (Match review): every signal the checks need for this robot profile, marked ✅ logged, ⚠️ logged
  too slowly or never changes, ❌ not logged, or ⬜ no key in the robot profile. The to-do list comes first. Each line
  says which checks go dark without the signal, what those checks exist to catch, and the key to log it under. It
  says what to log, never how: the robot code is the team's to write.
- **Wanted checks** (same tab): problems no check can catch yet, because the robot doesn't log what it would take.
  Each becomes a real check once the signal is in a log.
- **Session view**, "Logging across the session": signals that appeared or vanished between matches, with the build
  each match ran, and signals missing from every match.
- **Companion library** (`companion/`, [its README](companion/README.md)): an optional vendordep for AdvantageKit
  robots.
  - It logs what AdvantageKit, Phoenix's hoot recording and PhotonVision don't: CANivore bus status, roboRIO CPU and
    memory, Java heap, and log-drive space.
  - For each CTRE device passed to `HindsightDevices.watch()`, it also logs whether the device answers, its firmware,
    its faults and its reboots.
  - Hindsight and Foresight read these keys when they are there. A robot without the library still gets every other
    check.
  - No vendordep is hosted yet: build it from `companion/`.

## Robot snapshot

**Robot snapshot** (top of the page) reads a `snapshot.json` taken with `python3 tools/robot-snapshot.py` while the
robot is on and tethered: every CTRE device's model, CAN ID and firmware, the current limits each motor is really
running against the profile's, and sticky faults (Undervoltage, BridgeBrownout, BootDuringEnable first). A second
snapshot shows exactly what changed. The collector only reads (five allowlisted actions, HTTP GET, no retries) and can
also list, copy and convert Phoenix `.hoot` logs with the owlet AdvantageScope already cached. Student guide:
`docs/robot-snapshot.md`.

## sim-run: robot code in the desktop simulator

`node scripts/sim-run.ts <robot-code folder>` builds a copy of the code, runs it in WPILib's desktop simulator with no
window, and drives it like a Driver Station: start up and enable twice, every auto in the chooser on blue and red, and
drive forward on both alliances, plus the team's own scenarios. It reports crashes (with the line in your code), zeroes
cut off by another command or never finished, autos that don't finish or don't move, red behaving like blue, and the
team's own expectations; Hindsight's rules run on each run's log. It never changes the robot-code folder. How to write
a scenario file: [docs/sim-run.md](docs/sim-run.md).

## Foresight: the pre-match go/no-go, live (phase 1)

Built to `8033/robot/foresight-phase1-brief.md`. **Foresight** (top of the page) connects to the robot over a tether
in the pit or the queue and runs the same rules and robot profile on the robot's live NetworkTables, before the match
instead of after it. One verdict, readable at arm's length: **GO**, **NO-GO** or **NOT CHECKED**, then the findings
worst first, each red with the one thing to do before the robot goes on the field (swap the battery, redeploy from a
commit, reseat a controller).

- **Read-only.** It only subscribes (`src/foresight/nt4-client.ts` refuses anything else, tested), to the ~109 signals
  its checks read for this robot, never the whole tree.
- **Never on the field.** The moment `/DriverStation/FMSAttached` (or WPILib's `/FMSInfo/FMSControlData`) says the
  field is attached it disconnects, shows "On the field: close Foresight.", and won't connect again until the page is
  reloaded. If the robot publishes neither, it disconnects: it can't tell where it is.
- **Settle:** nothing is judged until 30 s after the robot code started (start-up camera and time-sync alerts clear in
  12.5–18.9 s in the 2026 logs). A robot already on for 30 s gets a verdict at once.
- **Checks:** `power/rest-voltage`, `can/device-dropout`, `foresight/values-updating` (a connected device's readings
  frozen 5 s while others change), `foresight/controllers`, `foresight/zero-sanity`, `foresight/motor-temperature`
  (above 60 °C), `build/dirty`, `vision/stale` (drop-outs only, while disabled), `vision/time-sync`, the battery
  tracker's two, `foresight/commit-matches` (code changed since the last GO, kept in `hindsight-history.jsonl`),
  `foresight/log-usb-stick` (the companion library's `/Hindsight/LogDrive/OnUsb`; "not checked" on a robot without
  it), `alerts/passthrough`, `foresight/camera-sees-tag` (a step: "hold an AprilTag up to Back_Left" until each camera has
  seen one; never moves the verdict), and `foresight/gyro-still-drift` as context. Not here: the auto choice and
  alliance (they reset on the field).
- **Wanted checks** (`src/rules/wanted.ts`) fold away under the pit checklist as grey context: problems no check can
  see yet, never a finding and never in the verdict. One whose covering check could run drops off the list.
- **Red is earned:** every check is amber until `scripts/foresight-backtest.ts` finds no false reds on field logs;
  the screen says how many logs each red was proven on (`src/foresight/proven.ts`, `docs/measurements.md`).
- **Download for Claude** (under Readings) saves the counts, clock, verdict and which signals never came.

First time on a robot: [docs/foresight-first-robot.md](docs/foresight-first-robot.md). Not yet run on a roboRIO; tested
against the team's 2026 logs replayed as NT4 and against desktop ntcore (pyntcore 2025.3.2) in Chrome from `file://`.

## Build checks in your robot's build (Gradle plugin)

One line in a WPILib robot's `plugins {}` (`id "io.github.kevinclark.hindsight"`) adds checks to every build: a short
allowlist of Error Prone warnings, integer division (`50 / 12` is 4) and a few style slips fixed in place on laptop
builds and never during a deploy, the three alerts that have only found real bugs failing CI, a check that the robot builds and runs through
disabled, auto, teleop and disabled in simulation, and a pre-commit format hook. Each is off by name in
`hindsight {}`. Not on the Plugin Portal yet; details, costs and the off switches:
[companion/gradle-plugin/README.md](companion/gradle-plugin/README.md). It pairs with the code check below, which
reports on pull requests.

## Code check in your team's CI

The code check (Foresight's "does the robot code have a mistake that costs matches") also runs as a GitHub Action: on
each pull request it reads your Java, compares with the base, and shows what the change **adds** as annotations on the
changed lines plus a table on the run's summary page. It reports; it does not block unless you ask it to. Findings are
context for the team, not a verdict on a change or on anyone. License: BSD-3-Clause (`LICENSE`).

```yaml
# .github/workflows/code-check.yml
name: code-check
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:                      # two overlapping runs on one pull request could each post a comment
  group: code-check-${{ github.event.pull_request.number || github.sha }}
  cancel-in-progress: true
jobs:
  code-check:
    runs-on: ubuntu-latest        # not the WPILib container: setup-node needs the runner. Its own job: setup-node
                                  # changes the Node version for the later steps of the same job
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: kevinclark/hindsight@<full commit sha of a Hindsight commit>
        with:
          fail-on: none           # later, once you trust it: new
```

- **Pin a full commit sha**, not a tag or `main`. Then a new rule can't turn your CI red or add findings until you move
  the pin on purpose.
- **Use checkout's defaults** (no `ref: ${{ github.event.pull_request.head.sha }}`). The action compares the checked-out
  merge of the pull request against the pull request's base; checking out the head instead makes the base look older than
  it is and over-counts "fixed". Keep `persist-credentials` at its default (true) in a private repo, so the action can
  fetch the base commit in a shallow clone; if it can't, it says so, reports every finding as "not compared" and never
  fails because of it.
- **`fail-on`**: `none` (default) never fails; `new` fails when the change adds a finding (and passes when the base can't
  be read); `any` fails on any finding at all, including old ones, which punishes whoever touches the repo next.
- **`exclude-rules`**: a comma list of rule ids to leave out. A team whose build already stops whole-number division in
  the compiler (Error Prone's NarrowCalculation, say) writes `exclude-rules: code/integer-division`.
- **`path`** is the folder holding the `.git` (default `.`, the workspace root). Keep the default: GitHub attaches an
  annotation to a pull request's file only when the path is relative to the workspace root, so with another `path` the
  annotations show on the run page but not on the files. **`base`** overrides the commit compared with (the default is
  the pull request's base, a merge group's base, or on a push the commit before it). It must be a commit hash (7-40 hex
  characters); a branch name is reported as "not compared". The merge-group default is untested: no data covers it.
- **Outputs**: `findings`, `new`, `fixed`, `compared`.
- **`comment: true`** (default `false`) also puts the report in **one pull-request comment**: what the change adds
  (and how many findings are fixed), with the older findings folded under "already in the code". Give that job
  `permissions: pull-requests: write` (and keep `contents: read`); without it the step prints one line saying so and
  carries on, and the exit code never changes. It posts only when something is new or fixed (and, when the base can't be read, no comment is posted; an existing one
  is updated to say so), and after that keeps the
  same comment up to date (it says "Nothing new in this change." once the change is clean again) instead of adding more.
  A pull request from a fork gets none, and neither does a run started by Dependabot: their tokens are read-only, and the action never uses `pull_request_target`. Why
  it exists: GitHub does not document annotations or step summaries on GitHub Mobile (comments are a core Mobile
  feature), and re-running only the other failed jobs carries this job into a new attempt with no annotations (seen on
  a real repo: 11 notices on attempt 1, 0 on attempts 2 and 3). The comment lists at most 50 findings, new first, and
  links the run's summary page for the rest. **It is visible to everyone who can see the pull request**, and it is
  context for the team, not a verdict. Finding names link to the files only when the checked folder is the job's own
  checkout (`path` left at the default); otherwise they are plain text. `token` overrides the token used (the default is the job's own).
- **Annotation cap:** GitHub's docs give 10 warnings and 10 errors per step; the 10 notices per step and the 50 per job
  come from the docs of `actions/toolkit`. Either way the rest are dropped silently. New findings are warnings and the
  rest notices, each with its own cap, so up to 10 new and 10 other findings show; the summary page lists every finding.
- **How a finding is matched with the base:** rule + file + the text of its line, not the line number (adding a line
  above moves findings) and not the message. A finding whose line is edited, or whose file moves, counts as one new
  and one fixed. Known limit: two findings of one rule in one file on lines with identical text can swap without
  anyone noticing, so a new one may hide behind an old one (the counts stay right).
- **Cost** (measured on a 49-file robot repo on a Mac): the check with a comparison takes about 0.6 s; installing the
  two parsing packages (`npm ci --omit=dev`, 8.5 MB) took 0.2 s with npm's cache warm. On a GitHub
  `ubuntu-latest` runner (2026-10-21, the self-test): the install took 0.9 s and the whole action step about 2 s.
- Run the same thing on a laptop: `node --experimental-strip-types scripts/code-check.ts <robot folder> --base <commit>`
  (add `--fail-on new`, `--exclude-rules a,b`; `--github` and `--comment` are for CI).

`.github/workflows/code-check-action.yml` tests the action on every change to it, on a small repo of invented code
built in the job: 13 findings, 12 new, 1 fixed, that `fail-on: new` fails, and (on a Hindsight pull request) that
`comment: true` leaves exactly one comment.

## Build and test

```
npm install
npm test          # unit + fixture tests; also the team's real logs if they are listed in ~/.hindsight/team-logs.json
npm run build     # writes hindsight.html (one self-contained file) and dist/index.html
npm run check     # type-check
python3 -m unittest discover -s tests -p 'test_*.py'   # robot-snapshot collector (stub server, no robot)
node --experimental-strip-types scripts/check.ts <log.wpilog> [<log.dslog>]   # report in the terminal
node --experimental-strip-types scripts/chrome-check.ts <out-dir> <logs…>      # file:// timing in headless Chrome
node --experimental-strip-types scripts/foresight-backtest.ts <logs or folders>  # Foresight's checks on field logs
node --experimental-strip-types scripts/chrome-foresight-check.ts <out-dir>      # Foresight in Chrome against replays
```

`.npmrc` turns off dependency install scripts (`ignore-scripts=true`) on every npm version: the only one npm 10 runs,
tree-sitter-java-orchard's, would compile a native binding the code check never loads (it uses the package's
`.wasm`). `npm run …` and `npm test` still run their own script.

The team's real logs are never committed. They are listed in the untracked local file `~/.hindsight/team-logs.json`;
the tests and scripts read them read-only and skip with a message when they aren't there; `fixtures/*.json` are small cuts that keep the core rules tested anyway.

## How it is put together

| Folder | What |
|---|---|
| `src/readers/` | `wpilog.ts` (indexes the file once, decodes only the signals asked for), `dslog.ts` |
| `src/match/` | `match.ts` (phases, event, build, wall clock), `series.ts` (hold-last helpers) |
| `src/profiles/` | one file per robot (log keys, motor groups, current limits, the code they were read from); `index.ts` lists them, `choose.ts` picks one per log |
| `src/rules/<area>/` | one rule per file, 25–55 lines; the list is `src/rules/index.ts` |
| `src/rules/rule.ts`, `view.ts`, `run.ts` | how a rule is written, what it can ask about a match, and the runner |
| `src/code/` | code at a commit (`source.ts`): from a code folder's `.git` (loose objects and packs, `git.ts`) or a public GitHub repo (`github.ts`), and the limit-line comparison |
| `src/triage/` | known issues and the history file |
| `src/power/` | battery model, resistance from current steps, open-circuit curve, what-ifs, fleet reference |
| `src/report/` | `findings.json`, the Match review, Foresight and Session report models, the phone card |
| `src/foresight/` | the live pit check: read-only NT4 client and field guard, record store, engine, verdict, earned reds |
| `src/hub/` | the log library: manifests, catalog, facets, ingest, Drive adapter, sync, robot pull ([docs/library.md](docs/library.md)) |
| `electron/` | the desktop app: window, the page's way into the library, Google sign-in, readers in a utility process |
| `src/ui/`, `src/App.svelte` | the page |

Adding a rule: [CONTRIBUTING.md](CONTRIBUTING.md).

## Measured (2026-10-19, M5 Max)

Chrome 155, headless, page opened from `file://`, logs loaded through the page's file input, one log per fresh page
(three runs each):

| Log | Size | Index + match model | All rules | Drop to rendered | Renderer memory added at peak |
|---|---|---|---|---|---|
| Log A + its .dslog | 52.6 MB | 55–56 ms | 59–62 ms | ~200 ms | +145 MB |
| Log B | 54.1 MB | 56–57 ms | 58–59 ms | ~200 ms | +182 MB |
| Log C | 56.5 MB | 62–63 ms | 68 ms | ~200 ms | +188 MB |
| all three + .dslog | 163 MB | | | ~400 ms | +320 MB |

Details and how they were taken: [docs/measurements.md](docs/measurements.md).

## Who it is for

Each rule names who acts when it fires: the **software team** (code and config), the **pit crew** (mechanisms,
wiring, batteries) or the **drive team**. The Match tab filters by that.

**Known issues:** mark a finding *known* (we're on it) or *fixed* (with a note). Known issues leave the red list; a
fixed one that fires again in a later match comes back at the top. *Real problem…* confirms one match's finding without
filing it away. *Not a real problem…* (with a reason) files one match's finding as a false alarm and turns the same check's reds amber on the event's other matches; each finding then
says how sure its check is from the team's marks. The record is `hindsight-history.jsonl`: save it
from the page and drop it in with the logs next time. Design and what's next (the pit board, wear trends):
[docs/audiences-and-triage.md](docs/audiences-and-triage.md).

## Not verified

- **The Session view keys its saved summaries by the code folder's name.** A summary read when a commit couldn't be
  compared (a shallow clone, say) is reused after choosing a fuller clone with the same name, until the logs are added
  again or "Clear saved copies". Kept limit-line answers (about 150 bytes each) are never pruned.
- **The remembered code folder is not exercised.** Chrome's folder picker (`showDirectoryPicker`) and the "Use … again"
  permission after a reload need a person to click; only the folder input path was driven (headless Chrome from
  `file://`, through `scripts/report.ts --code`).
- **GitHub from `file://` was driven headless; the pane drove it from localhost.** `scripts/report.ts --github` (headless
  Chrome, `file://`) and the browser pane (localhost: the pane can't open `file://`) both read log B's limit lines from
  GitHub and matched the folder. A real 403 for a used-up hour was never fetched (it would spend the hour): its message
  is tested on a scripted answer, and that GitHub sends CORS headers on it is assumed. raw.githubusercontent.com's own
  limits are undocumented and not measured.
- **Windows and Chromebook are not verified.** Only Chrome 155 and Safari on macOS were checked.
- **Safari's file picker is not exercised.** Safari rendered both tabs for all three logs, but through a test copy of
  the page with the log embedded (Safari's WebDriver is off on this Mac). Chrome was driven through the real file input.
- Analysis runs on the page's main thread: 120–130 ms per log here, so a slower laptop freezes the page for a moment.
  A Blob worker (design-detail §7) is the fix if that shows up.
- Student laptops are slower than an M5 Max; the timings above are an upper bound on speed, not a promise.
- Every threshold is an assumption until it is backtested over the 808-log archive (phase 2), apart from the
  2026 fixtures each rule must fire on.
- The "healthy battery" reference curve is two batteries from one weekend (log A, log B), so only log C tests the 1.5 V
  line. Charge past 6.25 Ah has no reference and is listed as "partly checked".
- Power numbers don't fully reconcile with the earlier analysis docs. Charge drawn reads 5.79 / 6.52 / 6.38 Ah
  (log A / log B / log C) against 5.47 / 6.18 / 6.01 Ah there; the motors alone are 5.65 / 6.39 / 6.25 Ah, so 0.18–0.24 Ah is
  unexplained (the script behind the docs' figure isn't in the repo). The open-circuit estimate for log B at 5.75 Ah is
  10.50 V here against 9.80 V at 5.6 Ah in REVIEW.md (a point estimate under load; this is a 0.5 Ah median). The
  last bin of a curve reads high when it includes post-match rest.
- DS logs with power-distribution data (REV PDH or CTRE PDP on CAN) are read by skipping that data, using
  AdvantageScope's record sizes; no such DS log has been tried.
- Battery rules (`battery/identity`, `battery/gauge-capacity`) are tested only on synthetic logs: no match log has
  the FRC8033BatteryTracker keys yet.
