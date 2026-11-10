# motor-running-free contract (`src/rules/mech/running-free.ts`)

Intent: the rule `mech/motor-running-free` tells the pit crew that one motor of a group whose motors share a control
loop turned faster than its partners while drawing far less current, for seconds at a time: it was no longer driving
the mechanism (a belt off, a pulley loose on its shaft, a broken coupling) and the others carried the load alone. It
runs once per same-loop motor group of the robot profile, on one match log, and returns at most one finding per group.
It reads the profile's motors, their velocity, stator current and Connected flag, and the enabled window; it does
**not** judge a follower that lost its Follower request (that follower is dragged at the same speed: `can/*` and
`mech/follower-mismatch`), a motor that is slower than its partners, or current limits (`power/limit-not-applied`).
Readers: the pit crew and mechanism students in the app (title, evidence, causes, plot), session summaries and the issue
board (the finding's `key`), and whoever rebuilds it. Spec: the rule's own header and `thresholds`, `src/rules/rule.ts`.

Suite: `npx vitest run tests/running-free.contract.test.ts --reporter=junit --outputFile={junit}`

## Interface
- `export default rule({...})` from `src/rules/mech/running-free.ts`: a `Rule` with `forEach: 'motorGroup'`,
  `only: (group) => group.sameLoop`, `needsEnabled: true` and `check(group: GroupView, match: MatchView)`; registered
  in `RULES` (`src/rules/index.ts`), beside `mech/follower-mismatch`.
- Collaborators it uses and must not reimplement: `GroupView`/`MotorView` (`src/rules/view.ts`): `motors` in profile
  order, each with `velocity()`, `stator()` and `connected()` (a `Signal`, or `MissingSignal` when the profile or the
  log lacks the key); `MatchView.grid(dt)`, `MatchView.enabled`, `inside(window, t)`, `Signal.onGrid(grid)`;
  `couldNotCheck`.
- Constants it exports: `RUNNING_ABOVE` (5), `FASTER_THAN` (1.04), `CURRENT_UNDER` (0.5), `FREE_LINE_SECONDS` (2).
- A motor's speed is its velocity key's own unit (rot/s for the 2026 offseason robot); sizes are absolute values.

Terms used below:
- **comparable moment**: a moment of the 20 ms grid over the match when the robot is enabled, every motor of the
  group that has a Connected flag reads connected (0.5 or more), and every motor of the group that has velocity and
  stator current turns faster than 5.
- **free**: at a comparable moment, a motor whose speed is more than 1.04 times the median speed of the other motors
  and whose stator current is under 0.5 times the median stator current of the other motors.
- **stretch**: a run of consecutive grid moments where the same motor is free; a moment that is not comparable, or
  where that motor is not free, ends it.

## Obligations

### Compatibility
- **RF-01** The descriptor has `id: 'mech/motor-running-free'`, `severity: 'warning'`, `judges: 'fault'`, `who:
  ['pit']`, `forEach: 'motorGroup'`, and cause ids `belt-off`, `loose`, `broken` in that order; a finding's key is
  `mech/motor-running-free · <group>`. Why: saved session summaries, the issue board and known issues match on the id
  and the key; a fault is kept however short the run (ADR 8). Kind: compatibility.

### Behaviour: when it fires
- **RF-02** It fires when one motor's longest stretch is 2 s or more: one finding for the group, dated at the start of
  that stretch. Why: the free motor is the physical fault; one line per group keeps a four-motor group from repeating
  it. Kind: behaviour.
- **RF-03** The finding names the free motor, the leader included: the free motor is judged against the median of the
  others, never against the first motor of the group. Why: the leader runs free as well as a follower can (a pulley
  on the leader loose on its shaft), and the group's first motor is not special to the mechanism. Kind: behaviour.
- **RF-04** A stretch under 2 s does not fire; stretches are not added together. Why: a healthy pair can run apart for
  a moment at a spin-up; the longest healthy stretch measured was 0.5 s (rollers) and 0.1 s (kicker), the faults
  4.7 s and longer. Kind: behaviour.
- **RF-05** A motor that turns faster but draws the same current as the others (half their current or more) is not
  free. Why: a pair out of step while spinning up or coasting still carries load on both motors. Kind: behaviour.
- **RF-06** A moment that is not comparable ends a stretch: a Connected flag that reads false for any motor, any
  motor at or under 5, or the robot disabled. Two stretches of 1.5 s split by one such moment do not fire. Why: the
  held value of a dropped controller or a disabled motor is not a motor running free. Kind: failure mode.
- **RF-07** In a group of more than two motors, one free motor fires and is named; the others' medians are taken
  over every other motor of the group. Why: the 2026 flywheel group has four motors. Kind: behaviour.
- **RF-08** A group with no comparable moment at all is not checked: `match.couldNotCheck('the motors never
  all ran above 5 together while enabled and connected')` (the report prefixes the group name), and no finding. A group with fewer than two motors that
  have velocity and stator current in the profile and the log is not checked either (`MissingSignal`). Why: a quiet
  match counts as clean in a session (`src/session/stopped.ts`), so "never compared" must not read as "held".
  Kind: failure mode.

### Behaviour: what the finding says
- **RF-09** The title is `<motor> ran free for <seconds> (longest stretch): <p> % faster than the others on <a> A
  against <b> A` with the free motor's median speed and stator current over its longest stretch against the others'
  medians over the same stretch. The evidence, in this order: `free motor`, `longest free stretch (s)`, `total free
  seconds` (all that motor's stretches), `stretch from (s)`, `stretch to (s)`, `free motor: median speed`, `free
  motor: median stator current (A)`, `others: median speed`, `others: median stator current (A)`. `measured` is the
  longest stretch (s, threshold 2) then how much faster (%). Why: the numbers are the student's proof that the motor
  was not loaded. Kind: behaviour.

### Behaviour: the 2026 offseason profile
- **RF-10** The 2026 offseason robot profile has a motor group `Kicker`, `sameLoop`, of the two kicker motors, each
  with a velocity key, and the indexer feed motor stays in its own group `Indexer`; both keep the 40 A supply and
  60 A stator limits. The event-code profile still gives the kickers 30 A supply and the feed motor 40 A. Why: the
  kickers share one control loop (the follower copies the leader) and used to sit in a group with the feed motor, so
  nothing could compare them; the split must not change a limit verdict. Kind: behaviour.
