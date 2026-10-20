# Measurements (2026-10-19)

Machine: the M5 Max MacBook Pro this was built on. Browser: Google Chrome 155.0.8059.80, headless (`--headless=new`),
fresh profile, `--enable-precise-memory-info`. Page: `hindsight.html` opened from `file://`. Logs loaded through the
page's own `<input type=file>` (CDP `DOM.setFileInputFiles`), so the real File → ArrayBuffer path is timed.
Script: `scripts/chrome-check.ts`. Each row is a fresh page in a fresh Chrome; three runs each.

| Load | Read files | Index + match model | All rules | Drop to rendered (wall) | JS heap after | Renderer RSS added at peak |
|---|---|---|---|---|---|---|
| Q13 (52.6 MB) + its .dslog | 16–17 ms | 55–56 ms | 59–62 ms | 197–199 ms | 83–84 MB | +144–145 MB |
| Q21 (54.1 MB) | 17 ms | 56–57 ms | 58–59 ms | 196–198 ms | 80 MB | +181–182 MB |
| P0 (56.5 MB) | 17–18 ms | 62–63 ms | 68 ms | 198–202 ms | 86 MB | +187–188 MB |
| All three + the .dslog | 19–21 ms | 47–56 ms each | 49–62 ms each | 398–399 ms | 244 MB | +319–320 MB |

(Re-measured after the review fixes, same method; the first pass was within 1–3 ms, except P0 wall ~245 ms.)

- "All rules" includes decoding every signal the rules ask for (the reader decodes lazily) and the power model.
- "Renderer RSS added at peak": the largest sum of resident memory over this Chrome's renderer processes, sampled every
  50 ms during the load, minus the sum before the drop (≈ 773 MB across Chrome's renderer processes at idle). The JS
  heap figure is `performance.memory.usedJSHeapSize` after the page rendered.
- Node 26 on the same machine (`scripts/check.ts`): index 49–58 ms, rules 47–62 ms per log.

Not measured: Windows or Chromebook laptops, older/slower hardware, Safari timing (Safari was checked for rendering
only, through a test page with the logs embedded, because Safari's WebDriver is disabled on this Mac).

## Rendering checks

- Browser pane (Chromium, served from localhost because the pane can't open `file://`): both tabs, all three logs,
  375 px wide (no horizontal scroll).
- Chrome 155 from `file://` via the file input: both tabs, all three logs (screenshots in the session, not committed).
- Safari from `file://`: both tabs for Q13, Q21 and P0, via a test copy of `hindsight.html` with the log embedded
  (made outside the repo; the real file-picker path in Safari is not exercised).

## Foresight backtest (2026-10-19)

`node --experimental-strip-types scripts/foresight-backtest.ts <logs>` on 11 match logs: the three CalGames 2026
logs (8033: Q13, Q21, P0, from `~/Downloads`) and the eight public logs in `8033/robot/public-logs/` (teams 1741 ×2,
2151, 2204, 340 ×2, 3602, and an unnamed 2026 team: 2024–2026, AdvantageKit and plain WPILib logs). All 11 had the
field attached before the first enable; none was excluded. Each was checked every 10 s from max(code start + 30 s,
field attach) to the first enable, with the live check's own engine (`src/foresight/engine.ts`), 14–35 checks per log,
over 138–345 s of disabled robot on the field. 91 s for all 11 on the M5 Max.

| Check | Logs it could judge | Fired on | Judged | Verdict colour |
|---|---|---|---|---|
| `power/rest-voltage` | 9 | Q21 (12.45–12.48 V; Hindsight also flags it before auto) | true | **red**, proven on 9 |
| `build/dirty` | 6 | P0 (123eec6, uncommitted) and one other team's public 2026 log (uncommitted) | both true | **red**, proven on 6 |
| `vision/time-sync` | 8 | none (start-up alerts clear before the 30 s settle) | — | amber: no real fire on our logs yet |
| `can/device-dropout` | 3 | none | — | amber: no real fire on our logs yet |
| `foresight/controllers` | 3 | none | — | amber: no real fire on our logs yet |
| `foresight/zero-sanity` | 3 | none | — | amber: no real fire on our logs yet |
| `vision/stale` (drop-outs only while disabled) | 3 | none | — | amber: no real fire on our logs yet |
| `alerts/passthrough` | 8 | one public 2026 log (QM36): "limelight name … is invalid" and "Vision Camera 0 Disconnected" | the Limelight-name alert is an always-on config nag: **false** | amber |
| `battery/identity`, `battery/gauge-capacity` | 0 | no log has the battery tracker's keys yet | — | amber |
| `foresight/commit-matches` | 0 | needs a passing pit check on record | — | amber |
| `foresight/gyro-still-drift` | 3 | context only (grey): no line | — | grey |
| `foresight/motor-temperature` (2026-10-19) | 5 (CalGames, 340 ×2) | none: the hottest motor before any enable was 31 °C (line 60 °C) | — | amber: no real fire on our logs yet |
| `foresight/values-updating` (2026-10-19) | 3 | none: all 16 readings changed in every 5 s window | — | amber: no real fire on our logs yet |
| `foresight/camera-sees-tag` (2026-10-19) | 3 | context only (grey): "Hold an AprilTag up to Back_Left / Back_Right" all along; no camera saw a tag before any match (0 of 62,681 results) | — | grey: a step, never a verdict |

Rerun 2026-10-19 (evening, PT) with the three new checks (59 s for all 11): every earlier row unchanged. The backtest now gives the
checks only the signals Foresight subscribes to (plus the DataLogManager keys and the log's struct schemas);
`--whole-log` gives the same report line for line.

"Could judge" means the check read its signals there; on other teams' logs the 8033 profile doesn't fit, so the
checks about our motors, devices, cameras and controllers skip them. The verdict colours are `src/foresight/proven.ts`;
red needs both a clean backtest and at least one real fire on 8033's own logs (Kevin, 2026-10-19: the five checks that
never fired stay amber until each catches a real fault on one of our logs). Today that leaves two reds, `power/rest-voltage`
(Q21) and `build/dirty` (P0). When a later log gives one of the five a real fire, set its `ourFires` in `proven.ts` from
that backtest run.

What the base can and can't say:

- **Thin.** Zero false reds in n logs bounds the per-match false-red rate only loosely: the 95 % upper bound is
  1 − 0.05^(1/n), 63 % for n = 3, 39 % for 6, 31 % for 8, 28 % for 9. Five of the seven reds have never fired on any
  log, so nothing yet shows they fire when they should (the synthetic tests in `tests/foresight-rules.test.ts` do).
- **Field, not pit.** These are disabled stretches on the field; the pit and queue have more handling. Count pit
  false reds again on the first live uses.
- **Before any enable only.** Every stretch ends at the first enable, so nothing here covers a robot checked after a
  drive. After the match the battery read 12.12 / 11.82 / 11.69 V 10 s after the last disable (Q13 / Q21 / P0, 2 s
  medians), 12.27 / 12.04 / 12.19 V after 60 s, and Q13 12.32 V after 160 s, against 12.64 / 12.45 / 12.65 V before
  auto. So after a drive the engine waits 10 s and then keeps `power/rest-voltage` amber, saying why
  (`src/foresight/engine.ts`).
- **Q21's number depends on the moment.** The brief's 12.43–12.47 V is the stretch before auto (2 s median 12.45 V);
  checked every 10 s across the disabled stretch it reads 12.45–12.49 V, all under 12.5 V.
- **What happened later** in each match is in the script's per-log output (Hindsight's findings in the match): Q21 went
  on to sag to 6.15 V, P0 browned out 53 times on a weak battery that rested at 12.65 V (rest voltage would not have
  caught it), Q13 sagged to 6.28 V from 12.64 V. No pre-match check here would have caught P0's collapse.

Measured along the way (CalGames, disabled on the field after the 30 s settle):

- Back_Right camera stale 37–40 % of the time, Back_Left 12.5–14 %: a disabled robot sees whatever tags are in view,
  so `vision/stale` judges only drop-outs before enable (its 15 % share line would have fired on all three).
- Gyro yaw drift per 20 s: 0.005–0.044° just before enable, 0.3–4.4° in the first one to two minutes after boot (Q21
  stayed above 0.25° for ~100 s). No line is set.
- Intake pivot against its CANcoder (× 1.7778): within 0.24° at rest (median 0.04–0.08°), up to 6.7° while moving.

Measured for the three new checks (2026-10-19, CalGames Q13, Q21, P0; "before" = code start + 30 s to the first
enable, "after" = 10 s after the last disable to the end of the log):

- **Motor temperatures** (19 Talon FX, `DeviceTemp`, the controller's own reading): 22–31 °C before, 60 °C the
  highest during a match (Back Right drive, Q21; swerve drives 51–60 °C, steer 43–49 °C, everything else 27–40 °C), 26–54 °C
  after. Line: above 60 °C, hotter than any motor ended a match. Measured; where the Talon FX derates is not.
- **Readings that change at rest.** Stator current changed 41–49 times a second on 15 motors and never sat still longer
  than 0.16 s, before or after; the gyro's yaw rate 46–49 a second, still at most 0.12 s. Position and velocity are no
  use: some still motors' (the swerve drives, flywheels, indexer) sat unchanged for the whole stretch before the match
  (228–345 s), the intake pivot's (fused with its CANcoder) changed every 0.1–0.9 s, and the swerve turn positions sat
  still for anywhere from 2 s to 184 s; the four flywheel
  motors' every signal sat still too, and a still CANcoder's position up to 110 s (Front Left, Q13). So `values-updating` watches stator
  current and yaw rate over 5 s (30× the longest still) and lists the CANcoders and flywheels as not checked.
- **Camera results and accepted poses.** 134,401 PhotonVision results from two cameras all parsed (`src/readers/photon.ts`).
  The accepted pose `/RealOutputs/Vision/<camera>/Pose2d` was logged in the same loop as a result with two or more tags
  every time (20,873 of 20,873), never for a one-tag result (0 of 19,095) and never without a tag: the code logs a pose
  only from the coprocessor's multi-tag result (`Camera.updateCamera`, `estimateCoprocMultiTagPose`). So
  `camera-sees-tag` passes a camera on its raw result showing one tag (or on a pose), not on the pose alone. Before
  any match no camera saw a tag: 0 of 62,681 results across the three field stretches.

## Foresight live (2026-10-19)

- **Engine:** 1–26 ms per check in Node on the M5 Max (66 signals, the stretch growing to 345 s). With the 105 signals
  of 2026-10-19 (evening), P0 at 345 s: 33 ms before the new signals, 207–276 ms with them (the 15 stator currents were 4/5 of the
  records), 67–74 ms once the "updating" readings are kept and written for their last 30 s only (`recentKeys`).
- **Replay, Node:** `tests/foresight-live.test.ts` replays the CalGames logs as NT4 (`tests/helpers/nt4-replay-server.ts`)
  into the real client: P0 → `build/dirty`, Q21 → `power/rest-voltage` 12.45–12.48 V, Q13 → nothing flagged from settle
  to the first enable; with FMSAttached as logged, the socket closes at the attach (27.3–28.5 s robot time) and a new
  attempt is refused without connecting.
- **Replay, Chrome 155 headless, `hindsight.html` from `file://`** (`scripts/chrome-foresight-check.ts`): the same four
  scenarios; the page sent only `subscribe` frames, no binary frame, and made no request other than the page and the
  NT4 socket.
- **Real ntcore:** a pretend robot on pyntcore 2025.3.2 (the C++ ntcore, one version before the 2026 roboRIO image)
  publishing the AdvantageKit-style topics: Chrome from `file://` connected (Origin `null` accepted), decoded int,
  double, boolean, string and string[] values, showed the countdown then the verdict (rest voltage 12.40 V, uncommitted
  code), and closed when FMSAttached turned true at 45 s. The connection stayed up 45–60 s with no NT4 clock-sync pings
  from the page. ntcore kept the metadata's publish timestamp for a late subscriber, so code start came "from the
  metadata". Not measured: a roboRIO, a real field, Windows.
