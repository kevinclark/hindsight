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
| `src/rules/<area>/` | one rule per file; the list is `src/rules/index.ts` |
| `src/power/` | battery model, resistance from current steps, open-circuit curve, what-ifs, fleet reference |
| `src/report/` | `findings.json` |
| `src/ui/`, `src/App.svelte` | the page |

Adding a rule: [CONTRIBUTING.md](CONTRIBUTING.md).

## Measured (2026-10-19, M5 Max)

Chrome 155, headless, page opened from `file://`, logs loaded through the page's file input, one log per fresh page
(three runs each):

| Log | Size | Index + match model | All rules | Drop to rendered | Renderer memory added at peak |
|---|---|---|---|---|---|
| Q13 + its .dslog | 52.6 MB | 56 ms | 60–61 ms | ~200 ms | +146 MB |
| Q21 | 54.1 MB | 56–58 ms | 59–60 ms | ~200 ms | +184 MB |
| P0 | 56.5 MB | 63 ms | 68–69 ms | ~245 ms | +189 MB |
| all three + .dslog | 163 MB | | | ~400 ms | +324 MB |

Details and how they were taken: [docs/measurements.md](docs/measurements.md).

## Not verified

- **Windows and Chromebook are not verified.** Only Chrome 155 and Safari on macOS were checked.
- Student laptops are slower than an M5 Max; the timings above are an upper bound on speed, not a promise.
- Every threshold is an assumption until it is backtested over the 808-log archive (phase 2), apart from the
  CalGames fixtures each rule must fire on.
- The "healthy battery" reference curve is two batteries from one weekend (Q13, Q21).
- Battery rules (`battery/identity`, `battery/gauge-capacity`) are tested only on synthetic logs: no match log has
  the FRC8033BatteryTracker keys yet.
