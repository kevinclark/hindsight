# Two customers, triage, and a pit board (design note, 2026-10-19)

Kevin, 2026-10-19: Hindsight has two customers. The **software team** changes code (current limits, logic errors,
configuration). The **pit crew** works on mechanisms and wiring and wants to find today's problems *and* anticipate
the next ones (part wear, bad wiring). Both need to identify problems, triage them and respond. A pit-centric
dashboard could support that.

Status: the **audience tag** below is built in phase 1 (cheap, no stored state). The **triage state, issue tracking
across matches and the pit board** need decisions from Kevin (end of this note) and land in phase 2 with the history
file the proposal already plans.

## 1. Who acts on each rule (built in phase 1)

Every rule carries `audience`: who acts when it fires. The Match tab filters by it (All / Software / Pit / Drive team).
A rule can have two: the fix for a brownout is partly battery handling (pit) and partly current limits (software).

| Rule | Software | Pit | Drive team | Why |
|---|---|---|---|---|
| power/brownout | ✓ | ✓ | | limits and load shedding in code; battery and wiring in the pit |
| power/battery-collapse | | ✓ | | pull and capacity-test the battery |
| power/margin | ✓ | ✓ | | same split as brownout |
| power/rest-voltage | | ✓ | | charging and battery rotation |
| power/wiring-resistance | | ✓ | | crimps, lugs, breaker |
| power/limit-not-applied | ✓ | | | a config flag |
| can/device-dropout | | ✓ | | connector, wire, terminator, power path |
| comms/loss, comms/ds-log-truncated | | | ✓ | DS laptop, field; the CSA if it repeats |
| auto/early-disable | ✓ | | ✓ | why the drive team stopped it; what auto did |
| auto/none-at-enable | | | ✓ | pick the auto after the field connects |
| mech/zero-not-completed | ✓ | | | command sequencing |
| mech/follower-mismatch | | ✓ | | belt, pulley, set screw |
| mech/stall, mech/slip | | ✓ | | a jam; a loose gear or pulley |
| collision/tilt, collision/impact | ✓ | ✓ | ✓ | inspect for damage; guard in code; driving |
| loop/overrun, vision/*, build/dirty | ✓ | | | code |
| battery/identity, battery/gauge-capacity | | ✓ | | gauge plugged in, battery rotation |
| alerts/passthrough | ✓ | | | whoever wrote the alert |

## 2. What "anticipate" can mean with the signals we already log

Wear shows up as a drift across matches, not a threshold in one match. Each line is a per-match number that phase 2
stores in `history.jsonl` and trends per robot, per mechanism, or per battery. ✓ = the signal is in today's logs.

| Early sign | Per-match number | Signal | Catches (from #in-hindsight) |
|---|---|---|---|
| Belt or pulley slipping | seconds a follower runs > 15 % off its leader | ✓ `*/VelocityRotPerSec` | pulley/belt failures (≥ 5) |
| Friction, rubbing, a bearing going | current at steady speed (kS/kV) vs physics and vs last week | ✓ supply/stator current + velocity | spindexer shaft rub |
| Motor running hot | temperature rise per minute of use | ✓ `*/TempC` | steer motor at 90 °C in 45 s |
| Connector working loose | CAN drops per device per match, rising | ✓ `*/Connected` | CAN dropouts (≥ 11) |
| Battery wearing out | open-circuit voltage at 4 Ah, resistance, per battery ID | ✓ voltage/current; battery ID needs the tracker library | P0 |
| Wiring degrading | battery + wiring resistance per match, rising | ✓ | crimps (brownout cases) |
| Module wear (swerve) | each module's drive current at a given speed vs its siblings | ✓ | — (not yet seen) |
| Hits adding up | count of > 3 g hits per match | ✓ since Q21 (accelerometer) | fasteners backing out (≥ 14) |

The thresholds for these are unknown until the 808-log backtest runs; phase 2 shows the trend first and flags only
what the backtest supports.

## 3. Triage and known issues

An **issue** is a finding with a stable identity: rule + what it is about (`mech/follower-mismatch · Flywheel`), so
the same problem in five matches is one issue with five sightings, not five rows.

**Built (2026-10-19), after Kevin chose the history file (decision 2: yes):**

- Every finding has *Mark as known…*, *Mark as fixed…* and *Treat as new*, each with a short note.
- **Not a real problem…** (2026-10-20) needs a reason ("deliberate A-stop"). Unlike known and fixed it is about one
  match only, and it files the finding with the known issues there. While it stands, the same check's reds on the
  other matches of that event (same event name, played within 4 days) show amber with "marked not a real problem in
  Q13: <reason>"; nothing is hidden. *Undo* writes `unmark`, which undoes only that mark (a build from before this
  feature skips both lines; a `new` would have cleared the issue's known or fixed mark there). The Session view does
  not apply the demotion yet.
- **How sure:** with any marks in the history, each finding says how its check has done on our matches, counted once
  per issue per match over the open logs plus every match named in the history: *marked real* (known or fixed on that
  very match), *a known issue* (another fire of a known issue, or one before its fix; nobody looked), *marked not a
  real problem*, and *not marked yet* (including a fire after a fix). With no marks it says nothing.
- **Known** issues leave the red list and sit under "Known issues seen this match", with the note.
- **Fixed** issues that fire again in a match played *after* the fix show at the top as **"Came back after a fix"**:
  the check that the fix worked. Matches played before the fix show it as "Fixed after this match".
- "Tracked issues not seen this match" lists known and fixed issues that stayed quiet (✓ for fixed ones).
- The record is `hindsight-history.jsonl`, one JSON line per change; lines are only added, so two laptops' files
  combine by concatenation and the newest line per issue wins. The page also keeps a copy in the browser; *Save* writes
  the file, and dropping it in with the logs loads it. findings.json carries each finding's status (`known`, `fixed`
  or `wrong`), and a demoted finding there is a warning with a `demoted` field naming the mark.

Example, the CalGames flywheel belt (known slip, fixed before elims):

```
{"type":"issue","key":"mech/follower-mismatch · Flywheel","status":"known","note":"belt slipping on the 17/18 shaft","when":"2026-10-17T21:40:00Z"}
{"type":"issue","key":"mech/follower-mismatch · Flywheel","status":"fixed","note":"new belt before elims","when":"2026-10-18T15:00:00Z"}
```

**Still to build (phase 2):** the pit board (open issues across every loaded match, grouped by mechanism — decision
2 below), trend sparklines for the wear signals in §2, and a "copy as GitHub issue" button for software findings.

## 4. Should the drive team have its own board?

**For a board:**
- Their window is the shortest (queue to field, minutes) and they're at the DS laptop, where the `.dslog` lives.
- The most frequent problem family in `#in-hindsight` is theirs: controller drops after touching field metal (≥ 8
  episodes), plus comms losses and DS-side crashes.
- What they act on is behaviour and DS-laptop setup (power plan, USB hub, grounding, driving style), not parts, so
  mixing it into the pit list buries it.

**Against (for now):**
- Today 5 rules carry `drive` (comms/loss, comms/ds-log-truncated, auto/early-disable, collision/tilt,
  collision/impact); 3 are shared with software or pit, so only 2 are drive-only. A board for 2 rules is mostly
  empty, and every board is one more thing to keep correct.
- What they need between matches is a short checklist (battery ID and rest voltage, DS laptop plugged in, controllers
  checked), not triage across matches; triage of a comms problem usually ends with the CSA/FTA or the software team.
- The controller-drop rule (§5b, `comms/controller-drop`) isn't built yet, so the board's main content doesn't exist.

➡️ **Recommendation: no separate board yet.** Keep the Drive team filter, and give the drive coach a "before the next
match" card at the top of the pit board (battery to use, its last rest voltage and collapse check, any open
drive-tagged issue). Revisit when `comms/controller-drop` lands: if drive-only rules reach ~5 and someone on the drive
team owns triage, split them out.

## Questions for Kevin

1. ~~Store triage state in `history.jsonl`?~~ Yes (2026-10-19); built.
2. Pit board grouped by mechanism, not by rule? ➡️ yes.
3. Drive team board? ➡️ not yet (§4).
