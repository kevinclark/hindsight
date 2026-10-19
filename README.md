# Hindsight

Lints FRC team 8033's robot match logs in the browser. A student drops a match's `.wpilog` (and the Driver Station
`.dslog`, if they have it) onto one HTML page and gets a lint report, worst first, and a power view for brownouts.
Nothing is installed and no file leaves the computer. Named after `#in-hindsight`: every problem we learn the hard way
becomes a rule that checks every later match for it.

Phase 1 of the design in `8033/robot/hindsight-proposal.md` (decisions) and `hindsight-research/design-detail.md`
(detail), built to `8033/robot/hindsight-build-brief.md`.

## Use it

- **Offline (events):** copy `hindsight.html` to the DS laptop and double-click it. Works from `file://`.
- Drop one or more `.wpilog` files, plus `.dslog` files. A DS log is matched to the robot log it overlaps on the wall
  clock; one from another match is reported and ignored.
- **Match** tab: findings, worst first. Each shows its evidence numbers, a plot of the moment, what to do, and the
  incident that taught us the rule. "Not checked" lists rules that couldn't run on this log.
- **Power** tab: lowest voltage and margin to the brownout setting, the loads at the deepest sags, the battery's
  estimated open-circuit voltage against charge drawn, and flywheel current-cap what-ifs with the model's error.
- **Download for Claude** saves `<log>.findings.json` (schema `hindsight.findings/1`): findings, evidence, summary
  statistics, short data windows and the fitted battery model. It never includes `/RadioStatus/*`, which carries a
  hashed Wi-Fi key.

## Session view: many matches at once

**Session** (top of the page) takes a whole folder of logs (an event, a practice day). Each log is read and boiled
down to a small summary, then dropped, so hundreds of logs fit: 160 logs (53 MB each) took 24 s in Chrome on an
M5 Max (147 ms per log); the page never stopped responding for more than about 0.2 s. The JS heap peaks around
220–240 MB while a log is being read; the summaries themselves are about 10 KB each.

- **Sessions**: matches on the field with the same event name within 4 days are one event (when the Driver Station
  logged no event name, on-field matches within 4 days of each other are); other logs are grouped by the day they
  were played. One match recorded in several logs (the robot program restarted during it: same match label, starting
  within 30 minutes) counts once, with a note. When the robot profile doesn't fit the logs (under 60 % of its
  signals present, e.g. another robot or another year's code), a warning says findings about specific mechanisms and
  match times may be wrong. The date comes from the robot's clock, or, when the clock wasn't set (a roboRIO 2
  that was never set reads 2024-12-18), from the AdvantageKit file name, with a note; logs with neither go to "Logs with no date". Move a log to
  another session or rename a session from the page.
- **Findings across the session**, merged by issue: how many of the matches it could be checked in it fired in, a
  95 % confidence interval (Wilson) for that rate, the range of the measured value and how far past the rule's
  threshold it went. In words: **consistent** (most matches, at least 3 checked), **intermittent** (some, or every
  match of only 2 checked), **once**,
  or **not enough data** (under 2 matches checked). A fixed known issue that fires in a later match shows as "came
  back after a fix".
- **Rule × match grid**: fired, quiet or not checked, per match. Click a match to open it in Match review.
- **Per match** small multiples on one scale per number: lowest voltage, time under 7 V, charge, battery + wiring
  resistance, slowest follower, auto loop overruns, vision outliers; coloured by battery ID (logged, or typed in).
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
  The drive wheel-slip test is shown but locked until Kevin agrees the procedure.
- `scripts/limits-reference.ts` recomputes the Part A numbers a second way: the method of
  `8033/robot/hindsight-research/whatif/current_limit_check.py` (5 ms hold-last grid, more than 5 A over the limit),
  applied to supply current. It shares the app's .wpilog reader, so it checks the interval maths, not the decoding;
  the comparison with the brief's Python-derived numbers covers decoding. Flywheel leader over 45 A: app 6.09 / 6.83 /
  6.75 s, reference 6.11 / 6.85 / 6.76 s, brief 6.06 / 6.80 / 6.72 s (Q13 / Q21 / P0); the 0.03–0.05 s differences are
  the grid and the enabled-time window.

### Where this differs from the brief (and why)

- **"Did the limit take?"** (redesign accepted 2026-10-19) The brief judges the most common 2 A bin of samples ≥ 30 A against ±10 % of the limit. On
  real CalGames spin-ups that check fails both ways: at 60 A the mode is 33–39 A (the motor rarely needs 60 A), and
  a follower whose 40 A limit wasn't saved has a mode of 35 A while peaking at 73 A. Per motor the wizard says:
  **didn't take** (more than 0.3 s above 110 % of the limit; a working CalGames limiter stayed above for up to 0.21 s),
  **held at the limit** (mode within ±10 %, the brief's check; the drive's real 40 A plateau, mode 38–40 A, passes),
  **never had to hold** (never above 110 %), or **can't tell** (above it only briefly, which a working limiter also
  does). On the CalGames spin-ups, 60 A and 50 A steps are "can't tell" whether or not the limit was saved, so those
  steps are plotted but left out of the recommendation until a run confirms them; the comparison with the no-limit
  step (lower peak, smaller dip) is what shows them working.
- **The recommendation** walks down from the highest limit and stops at the first one that is too slow, so a noisy
  low step can't win.
- **Runs 5 s apart** won't start from a standstill: the CalGames flywheel took more than 5 s to coast down (45 → 7 rot/s
  in 5 s). The run card says to wait until the wheel stops (about 10 s).
- **Spin-up time** is to within 10 % of the target speed: holding speed, the flywheel ripples ±5 % around its setpoint.
  With that, Q13/Q21/P0 spin-ups from standstill take 0.74 / 0.74 / 0.65 s (median), matching the P0 analysis's
  0.5–0.8 s. Only 7–13 spin-ups per match start from standstill (the analysis counted 15–27 of all kinds).
- **Shot recovery** (the match version of spin-up time) counts dips below 85 % of the target lasting ≥ 0.1 s: only
  0–3 per match, so treat it as a rough number until checked against video.

### To verify on the robot (unverified until a run confirms each)

- The took-effect check is only decisive where the no-limit run goes over 110 % of the limit for more than 0.3 s
  (on the CalGames spin-ups: 40 A and below). The first real sweep must confirm it at 60 and 50 A.
- A limit set in Phoenix Tuner X holds while the robot code runs, until the next boot.
- It applies the same way to the followers (CAN IDs 16–18) as to the leader (15).
- `SupplyCurrentLowerTime = 0` disables the step-down to the lower limit during the sweep.
- After the final code change, the read-back in Tuner X matches the code (`apply()`'s result isn't checked in code).
- The bench model in the tests (spin-up slows by the current ratio; battery = 12.6 V − 11 mΩ × current) predicts the
  real sweep. It only exists to exercise the wizard; the real numbers come from the students' runs.
- The drive wheel-slip test procedure (not runnable until Kevin agrees it).

## Build and test

```
npm install
npm test          # unit + fixture tests; also the real CalGames logs if they are in ~/Downloads
npm run build     # writes hindsight.html (one self-contained file) and dist/index.html
npm run check     # type-check
node --experimental-strip-types scripts/check.ts <log.wpilog> [<log.dslog>]   # report in the terminal
node --experimental-strip-types scripts/chrome-check.ts <out-dir> <logs…>      # file:// timing in headless Chrome
```

The CalGames logs are never committed. `tests/calgames-logs.test.ts` reads them read-only from `~/Downloads` and
skips with a message when they aren't there; `fixtures/*.json` are small cuts that keep the core rules tested anyway.

## How it is put together

| Folder | What |
|---|---|
| `src/readers/` | `wpilog.ts` (indexes the file once, decodes only the signals asked for), `dslog.ts` |
| `src/match/` | `match.ts` (phases, event, build, wall clock), `series.ts` (hold-last helpers) |
| `src/profiles/` | `2026-offseason.ts`: log keys, motor groups and current limits for this robot |
| `src/rules/<area>/` | one rule per file, 25–55 lines; the list is `src/rules/index.ts` |
| `src/rules/rule.ts`, `view.ts`, `run.ts` | how a rule is written, what it can ask about a match, and the runner |
| `src/triage/` | known issues and the history file |
| `src/power/` | battery model, resistance from current steps, open-circuit curve, what-ifs, fleet reference |
| `src/report/` | `findings.json` |
| `src/ui/`, `src/App.svelte` | the page |

Adding a rule: [CONTRIBUTING.md](CONTRIBUTING.md).

## Measured (2026-10-19, M5 Max)

Chrome 155, headless, page opened from `file://`, logs loaded through the page's file input, one log per fresh page
(three runs each):

| Log | Size | Index + match model | All rules | Drop to rendered | Renderer memory added at peak |
|---|---|---|---|---|---|
| Q13 + its .dslog | 52.6 MB | 55–56 ms | 59–62 ms | ~200 ms | +145 MB |
| Q21 | 54.1 MB | 56–57 ms | 58–59 ms | ~200 ms | +182 MB |
| P0 | 56.5 MB | 62–63 ms | 68 ms | ~200 ms | +188 MB |
| all three + .dslog | 163 MB | | | ~400 ms | +320 MB |

Details and how they were taken: [docs/measurements.md](docs/measurements.md).

## Who it is for

Each rule names who acts when it fires: the **software team** (code and config), the **pit crew** (mechanisms,
wiring, batteries) or the **drive team**. The Match tab filters by that.

**Known issues:** mark a finding *known* (we're on it) or *fixed* (with a note). Known issues leave the red list; a
fixed one that fires again in a later match comes back at the top. The record is `hindsight-history.jsonl`: save it
from the page and drop it in with the logs next time. Design and what's next (the pit board, wear trends):
[docs/audiences-and-triage.md](docs/audiences-and-triage.md).

## Not verified

- **Windows and Chromebook are not verified.** Only Chrome 155 and Safari on macOS were checked.
- **Safari's file picker is not exercised.** Safari rendered both tabs for all three logs, but through a test copy of
  the page with the log embedded (Safari's WebDriver is off on this Mac). Chrome was driven through the real file input.
- Analysis runs on the page's main thread: 120–130 ms per log here, so a slower laptop freezes the page for a moment.
  A Blob worker (design-detail §7) is the fix if that shows up.
- Student laptops are slower than an M5 Max; the timings above are an upper bound on speed, not a promise.
- Every threshold is an assumption until it is backtested over the 808-log archive (phase 2), apart from the
  CalGames fixtures each rule must fire on.
- The "healthy battery" reference curve is two batteries from one weekend (Q13, Q21), so only P0 tests the 1.5 V
  line. Charge past 6.25 Ah has no reference and is listed as "partly checked".
- Power numbers don't fully reconcile with the earlier analysis docs. Charge drawn reads 5.79 / 6.52 / 6.38 Ah
  (Q13 / Q21 / P0) against 5.47 / 6.18 / 6.01 Ah there; the motors alone are 5.65 / 6.39 / 6.25 Ah, so 0.18–0.24 Ah is
  unexplained (the script behind the docs' figure isn't in the repo). The open-circuit estimate for Q21 at 5.75 Ah is
  10.50 V here against 9.80 V at 5.6 Ah in REVIEW.md (a point estimate under load; this is a 0.5 Ah median). The
  last bin of a curve reads high when it includes post-match rest.
- DS logs with power-distribution data (REV PDH or CTRE PDP on CAN) are read by skipping that data, using
  AdvantageScope's record sizes; no such DS log has been tried.
- Battery rules (`battery/identity`, `battery/gauge-capacity`) are tested only on synthetic logs: no match log has
  the FRC8033BatteryTracker keys yet.
