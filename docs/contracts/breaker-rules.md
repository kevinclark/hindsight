# breaker rules contract (`src/rules/power/main-breaker-margin.ts`, `src/rules/power/pdp-breaker-margin.ts`)

Intent: two rules tell the software and drive students that a breaker would have tripped by its maker's own trip
curve. `power/main-breaker-margin` judges the 120 A main breaker by the robot's total motor current;
`power/pdp-breaker-margin` judges each motor's own breaker on the power distribution board by that motor's supply
current. Both heat the breaker's two band edges (`src/power/breakers.ts`: the `fast` edge is the earliest an in-spec
breaker may trip, the `slow` edge the latest) and fire when the **fast** edge reaches 100 % inside the match: a
breaker at the fast end of its band would have tripped. Which breakers come from the robot's power map
(`src/power/power-map.ts`, put on the match by `analyzeFiles`). They do not judge the radio, roboRIO or other
channels (nothing logs their current), do not model temperature or a breaker that has already tripped, and are amber
only: no log has a PDP-breaker trip, and three main-breaker matches passed the slow edge without tripping. Readers:
students in the app (title, evidence, plot), session summaries (the finding's `key`).

Suite: `npx vitest run tests/breaker-rules.contract.test.ts --reporter=junit --outputFile={junit}`

## Interface
- `export default rule({...})` from each file, registered in `RULES` (`src/rules/index.ts`). Main: a match rule
  (`needsEnabled` left off; no match is "not checked"). PDP: `forEach: 'motor'`, `only` the motors whose supply current
  the profile names.
- Collaborators: `match.currents()` (total and per-motor supply current on a 50 Hz grid), `match.powerMap`,
  `heat`/`steadyAmps`/`breakerFamily` (breakers.ts), `mainBreakerFor`/`breakerForMotor` (power-map.ts),
  `MotorView.canId`, `match.couldNotCheck`.

## Obligations

### Compatibility: what is already live
- **BR-01** `power/main-breaker-margin` keeps its id, its title `Close to tripping the main breaker`, severity
  `warning`, `judges: 'performance'`, `averagesOverTime`, audience `software` and `drive`, and never gives a finding
  severity `error`, at any current. `power/pdp-breaker-margin` is `warning`, `judges: 'performance'`, `averagesOverTime`, `forEach:
  'motor'`, and both are in `RULES`. Why: saved summaries and the board key issues by id; red was dropped on purpose
  (no data supports a red level). Kind: compatibility.

### Behaviour: main breaker
- **BR-02** The main rule fires when the fast edge's heat of the total current reaches 100 % at a moment inside the
  match, and is quiet below that (a constant 163 A fires; 103 A does not; a current that only reaches the line after the
  match ended does not). Why: the finding is about the match, not a value held in the log afterwards. Kind: behaviour.
- **BR-03** The title leads with the band position: `Main breaker: a breaker at the fast end of its datasheet band
  would have tripped <when>, though the slowest would not: fast edge <n> %, slow edge <m> %`, or `and so would the
  slowest` in place of `though the slowest would not` when the slow edge reached 100 % too; `<when>` is where the fast edge first reached 100 % inside the match. Why:
  the number alone reads as certain; the band says how sure. Kind: behaviour.
- **BR-04** The evidence has these keys, in this order: `fast edge, peak heat (% of the trip)`, `slow edge, peak heat
  (% of the trip)`, `judged against`, `datasheet curves`, `accuracy of the warn line`, the steady total current for
  the match's length (`steady total current that stays under the fast edge for this match's length (A)`),
  `total current, RMS over the minute before (A)`, `carried most of it`. The accuracy is `about ±<(1 + e)² − 1> %`
  with `e` the family's fast-edge `fitError.currentWorst`; the steady current is `steadyAmps` of the match's length at
  120 A on the fast edge. Why: the student can see how far past the line, how sure, and what would have been safe.
  Kind: behaviour.
- **BR-05** The main breaker comes from the match's power map: Optifuse when the map says so (the evidence names the
  Optifuse parts and the heat is Optifuse's, not Bussmann's), else Bussmann. `judged against` says `(set in the power
  map)` for a map's main and `(assumed: no main breaker set in the power map)` otherwise. Why: an assumption must be
  visible. Kind: behaviour.
- **BR-06** `measured` is one entry: the fast edge's peak in whole percent, unit `%`, threshold 100. Why: sessions
  compare how far past the line each match went. Kind: behaviour.
- **BR-07** A log with no match is "not checked" (`no match in this log`), as before. Kind: failure mode.

### Behaviour: PDP breakers
- **BR-08** The PDP rule gives one finding per motor whose supply current's fast-edge heat reaches 100 % inside the
  match, about that motor (its key is `power/pdp-breaker-margin · <motor name>`); motors below the line, and a
  motor the profile has no supply current for, give nothing. Why: one line per motor keeps a four-motor drive from
  filling the report. Kind: behaviour.
- **BR-09** The title names the motor, its CAN ID when the profile has one, its breaker and slot, and the band
  position: `<motor> (CAN <id>) · PDP slot <n> · REV 40 A: a fast-end breaker would have tripped <when>, fast <n> %,
  slow <m> %` (no second clause in brackets after the time's own). A motor on no slot says `slot not mapped` in place of the slot; with no breaker set anywhere it says
  `breaker not set: judged against the first legal 40 A breaker to trip here (<REV|CTRE|Snap Action>)`: each legal 40 A
  family is tried (the fast edge's heat of each) and the one whose fast edge reaches 100 % first is named, its slow edge
  quoted; the finding fires when any of them does. A slot on an MPM reads `MPM <number>
  slot <n>`. Why: a warning must say which physical breaker to go look at. Kind: behaviour.
- **BR-10** The breaker is the one `breakerForMotor` gives for the motor's name and CAN ID from the match's map: the
  same motor trips on a REV 40 A, a CTRE 40 A or a Snap Action 40 A at different currents, and a 30 A breaker sooner than a 40 A one.
  Why: that is the point of the map. Kind: behaviour.
- **BR-11** The evidence has these keys, in this order: `fast edge, peak heat (% of the trip)`, `slow edge, peak heat
  (% of the trip)`, `peak supply current (A)`, `seconds above the breaker's rating`, `breaker` (name, rating and where
  it was set), `slot` (or `not mapped`). `measured` is the fast edge's whole percent, threshold 100. Kind: behaviour.
- **BR-12** A motor on a breaker with no trip curve (an MPM's ATM breaker) is "not checked" for that motor, saying so,
  never quiet. Why: the curve is a known gap; silence would read as fine. Kind: failure mode.
- **BR-13** Nothing else is judged: the radio's, roboRIO's and other slots in the map produce no finding, whatever the
  total current. Why: nothing logs those channels' current. Kind: behaviour.
