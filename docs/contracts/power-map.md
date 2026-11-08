# power-map contract (`src/power/power-map.ts`, its history line in `src/triage/history.ts`, `src/analyze.ts`)

Intent: the robot's power map says which breaker sits in each slot of its power distribution board and what each slot
feeds. A CTRE PDP 2.0 reports nothing about that, so the pit enters it, as a line of the shared history file; this
unit reads it back. It keeps the line (one whole map per line), says which map was in effect when a match was played,
and answers the two questions the breaker rules ask: which breaker is this motor on, and which is the main breaker.
It does **not** draw the map or edit it (the app's), check the map for mistakes (two motors on a slot, a breaker over
40 A: the app's), or know trip curves (`src/power/breakers.ts`). Readers: the rules `power/main-breaker-margin` and
`power/pdp-breaker-margin`, and the app that writes the line.

Suite: `npx vitest run tests/power-map.contract.test.ts tests/power-map-view.test.ts --reporter=junit --outputFile={junit}`

## Interface
- A history line `{ type: 'power-map', v: 1, robot, from, main, usual, boards, by, seq, when }` (`PowerMap`):
  `robot` is the profile id (`profileId()`), `from` the ISO time the breakers took effect (apart from `when`, the
  write), `main` is `'bussmann'`, `'optifuse'` or `null`, `usual` is `{ family, ratingA }` for "every motor is on
  this" (family `rev-ato`, `ctre-ato` or `snap-action`) or `null`, and each board has `id`, `kind` (`ctre-pdp-2`: slots
  0 to 23; `rev-mpm`: slots 0 to 5, breakers of family `atm`), optionally `fedFrom: { board, slot }`, and `slots`, each
  `{ slot, breaker: { family, ratingA } | null, feeds: Feed | null }`. A feed is a motor (`name`, optional `canId`) or
  `radio`, `roborio`, `mpm`, `other` (optional `label`).
- `parseHistory` / `serializeHistory` (history.ts), `boardStamp`, `compareEvents`.
- `powerMapAt(history, robotId, atIso)`, `breakerForMotor(map, motorName, canId?)`, `mainBreakerFor(map)`.
- `analyzeFiles(files, profile, profiles, history)` (analyze.ts): sets `Match.powerMap` before the rules run.

## Obligations

### Compatibility: what is already live
- **PM-01** A well-formed line parses to a `power-map` event and serializes back to the same text, so saving the
  history writes it as it came. Old builds read an unknown type as an `OpaqueEvent`, and every other line type parses
  as before. Why: the history file is shared by laptops on different builds. Kind: compatibility.

### Behaviour
- **PM-02** A line that fails a check becomes an `OpaqueEvent` (kept, written back unchanged), never dropped and never
  half-read: a `v` other than 1, no robot, a `from` that is not a time, a main breaker other than `bussmann`,
  `optifuse` or `null`, a usual breaker of a family or rating that is not valid, a board of an unknown kind, a slot
  out of its board's range, a breaker family that does not fit its board (`atm` only on an MPM), a feed
  of an unknown kind or a motor with no name, no `by` device or role, or no numeric `seq`. Why: a half-read map would
  judge breakers nobody chose. Kind: failure mode.
- **PM-03** A power-map line is stamped like a board line: `boardStamp` counts it in the device's `seq` (the next
  `seq` is one more than the device's largest, whatever line type) and `compareEvents` orders it by `when`, device,
  `seq`. Why: two tabs must not repeat a `seq`, and "the newest line wins" needs a total order. Kind: behaviour.
- **PM-04** `powerMapAt` returns the line for that robot with the latest `from` at or before the time (a line from
  later does not apply, and a line for another robot never does); equal `from`: the later `when`, then the higher
  `seq` (a `seq` counts per device, so it only breaks a tie between one device's lines); null when none. Why: a breaker swap applies from that day on and old matches keep the breakers they ran
  with. Kind: behaviour.
- **PM-05** `breakerForMotor` finds a motor on a slot whose feed is a motor with the same CAN ID when both the motor
  and the feed have one (the names then do not matter, and a different ID is a different motor), else with the same
  name. Boards are searched in order. A found slot gives its breaker, its board id and slot number, `mapped: true`,
  `source: 'slot'`. Why: names drift, CAN IDs do not; but a feed written without an ID must still be found by name.
  Kind: behaviour.
- **PM-06** A motor on no slot gets the map's `usual` breaker (`mapped: false`, `source: 'usual'`). A motor on a slot
  with no breaker set is still `mapped: true`, with the board and slot, and its breaker is the usual one, or the
  assumed one (PM-07). Why: "every motor is on 40 A" is the common case, and a drawn slot with no breaker is not a
  reason to skip the motor. Kind: behaviour.
- **PM-07** With no map, or a map with no `usual` and no slot for the motor: `snap-action` 40 A as a
  placeholder with `source: 'not set'`, `mapped: false`; the rules then judge a not-set motor against the first legal 40 A
  breaker to trip (REV, CTRE or Snap Action: breaker-rules BR-09), so no family is assumed. Why: Snap Action trips soonest
  from about 140 % of its rating up but never below about 133 %, where REV and CTRE do, so no one family is the fastest. Kind: behaviour.
- **PM-08** `mainBreakerFor` gives the map's main breaker (`source: 'map'`), else `bussmann` with `source:
  'assumed'` (no map, or a map with `main: null`). Why: both Bussmann parts share one curve and Optifuse is the only
  other legal one. Kind: behaviour.
- **PM-09** `analyzeFiles` with a history gives each match the map in effect at its wall-clock start (the robot's
  clock when it was set), so two matches of one robot a day apart can judge different breakers; a match whose clock was
  never set gets the robot's latest map; no history or no line for its robot: `null`. History lines from dropped-in
  files count too, and the result's `history` stays only what the files held. Why: re-running old matches must not
  rewrite what they ran with. Kind: behaviour.
- **PM-10** A slot may be listed twice in a board: two feeds on one slot is a mistake the power map screen flags (R621),
  not a malformed line, so the line is kept as a map and written back unchanged. Why: the screen must be able to show
  the problem it warns about. Kind: behaviour.
- **PM-11** When the history changes the map in effect for an open analysis (`withPowerMaps`), `power/main-breaker-margin` and
  `power/pdp-breaker-margin` are run again on the same match (no re-parse), and the report is what a fresh read with that history
  gives (findings, evidence, "not checked" lines); every other finding is the same object as before. Nothing changed: null. Why: the
  pit changes a breaker while a log is open and the finding must follow at once. Kind: behaviour.
- **PM-12** A change made from a finding applies from that match onward (`planFromFinding`, `src/power/power-map-view.ts`): the
  changed map is written from the match's start, and every later line of that robot (each distinct later `from`) is written
  again with the same change applied (the main or usual breaker if changed, each slot that differs, an MPM board with it),
  keeping that line's own `from` and everything else on it, so a later edit in Tools no longer hides the change. Undo puts every
  line back as it was, a first map back to a map with nothing in it; "Only from now" leaves the match's start and the lines
  between as they were and starts the change at the given time. Why: lines are whole maps and the latest `from` wins, so without
  this a change made from an old match is hidden for every match after the next edit. Kind: behaviour.
- **PM-13** The map belongs to the robot, not to a branch of its code: a line's `robot` is the robot key (`robotKey()` in
  `src/profiles/index.ts`: the profile's name, a kept profile's id), and every reader looks a robot up by its key **or** its
  old id `name @ branch` (`mapRobotIds`, `powerMapAt` taking either), so a line written by 0.1.609 still applies and the two
  branch profiles of one robot share one map; a summary names the same ids (`summaryRobotIds`). Why: the breakers in the
  robot do not change with the branch the code runs from. Kind: compatibility.
- **PM-14** A power-map line may carry `exceptions`: `{ name, canId?, breaker: { family, ratingA } }` for a motor on a breaker
  other than the usual one without a slot (family one of the three PDP families, rating above 0, `canId` 0 to 62). A bad
  `exceptions` field makes the whole line an `OpaqueEvent`, written back unchanged; a line without the field is as before.
  The line stays version 1: a build from before this field (0.1.609) reads the line as valid, ignores the field and judges
  those motors by the line's `usual`; nothing else about the line changes for it. Kind: compatibility.
- **PM-15** `breakerForMotor(map, name, canId, default?)` answers, in order: the breaker of the slot the motor is on; the
  motor's exception (found by CAN ID when both have one, else by name, like a slot's feed); the map's `usual`; the robot's
  `breakerDefault.usual` (`source: 'default'`); else the not-set placeholder. Its `source` says which: `slot`, `exception`,
  `usual`, `default`, `not set`. A slot with no breaker set falls through. Why: a team that runs one breaker everywhere is done
  with the default, and one exception should not need a slot. Kind: behaviour.
- **PM-16** `mainBreakerFor(map, default?)` answers the map's `main` (`source: 'map'`), else the robot's `breakerDefault.main`
  (`'default'`), else Bussmann (`'assumed'`). 8033's four built-in profiles (2026 offseason on both branches, 2026 competition,
  2025 offseason) carry `breakerDefault`: the Bussmann main and REV ATO 40 A on every motor. Kind: behaviour.
