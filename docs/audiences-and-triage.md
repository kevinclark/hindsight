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
| mech/zero-not-completed | ✓ | | | command sequencing |
| mech/follower-mismatch | | ✓ | | belt, pulley, set screw |
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

## 3. Triage and response: the decisions

An **issue** is a finding with a stable identity: rule + subject (e.g. `mech/follower-mismatch · Flywheel follower 18`),
so the same problem in five matches is one issue with five sightings, not five rows. Each issue has a status
(new → acknowledged → fixed (with a commit or a pit note) → watching → closed, or won't fix), an owner (software /
pit / drive team), and a note. A fixed issue that fires again reopens itself; that is the check that the fix worked.

**The pit board** (pit-centric dashboard, a tab): open issues across every loaded match, grouped by mechanism
(Power, Flywheel, Intake, Drive, …), worst first, each with its last sighting, trend sparkline and the one action.
Layout follows the lean "andon board" idea (one glance tells you what needs a person now) and NN/g's
task-based navigation: the pit sees mechanisms, not rule ids. A printable "between matches" checklist comes from the
same list.

**Where the triage state lives** (the one hard decision; the app runs from `file://` with no server):

| Option | Works offline at events | Shared between laptops | Cost |
|---|---|---|---|
| A. `history.jsonl` file the app loads and saves (already in the proposal) | yes | only by copying the file (or a shared Drive folder when online) | low; the save is a manual download |
| B. A small shared web page with a database (hosted) | no (needs internet) | yes, live | medium; an account/host to run |
| C. Software issues go to GitHub issues on the robot repo; pit issues to a Google Sheet | GitHub/Sheets need internet | yes | low per item, but two systems and the pit avoids GitHub |

➡️ Recommendation: **A first, with C's "copy as GitHub issue" button for software findings** (the app writes the
text; a student pastes it; nothing posts automatically). It keeps the zero-install, offline-at-events promise the
whole design rests on. B can come later if laptops sharing state at events turns out to matter.

## Questions for Kevin

1. Store triage state in `history.jsonl` (offline, manual save), not a hosted database? ➡️ yes (A).
2. Pit board grouped by mechanism, not by rule? ➡️ yes.
3. Should the drive team be a third audience (comms, early disable, driving-caused hits)? ➡️ yes, as a tag only; no
   separate board.
