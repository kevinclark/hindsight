# Adding a rule

When something goes wrong at an event, the fix isn't only in the robot or its code: it becomes a rule, so every
later match is checked for it without anyone having to remember.

A rule answers one question about a match ("Was the battery charged when the match started?"). It is a short
description plus one function, `check`, that looks at one thing and says what's wrong, or nothing. The engine does
the rest: it finds the signals in the log, runs your check on every motor (or camera, or device) if you ask it to,
draws the plot, and lists the rule under "Not checked" when the log doesn't have what it needs.

## The whole idea in one example

`src/rules/power/rest-voltage.ts`:

```ts
import { rule, volts, round } from '../rule.ts'

const LOWEST_REST_VOLTAGE = 12.5

export default rule({
  id: 'power/rest-voltage',
  title: 'Battery not fully charged',
  severity: 'warning',            // 'error' (cost or nearly cost a match), 'warning' (margin eroding), 'info'
  who: ['pit'],                   // who acts on it: 'software', 'pit', 'drive'
  meaning: 'The battery started the match partly discharged, so it sags sooner and deeper under load.',
  causes: [                       // most likely first; each says what to look for, and where
    { id: 'not-charged', cause: "The battery wasn't charged", look: 'the battery cart: was this battery on the charger?' },
    { id: 'worn', cause: 'A worn battery that no longer holds a charge', look: 'Power tab: battery + wiring resistance' },
  ],
  nextStep: 'Put a battery reading 12.5 V or more at rest on the robot.',
  incident: 'CalGames 2026 Q21: 12.44 V before auto',

  check(match) {
    if (match.autoStart === null) return              // never enabled: nothing to check
    const rest = match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
    if (rest >= LOWEST_REST_VOLTAGE) return          // all good: return nothing
    return {                                          // something's wrong: say what, with the numbers
      message: `Battery rested at ${volts(rest)} before auto (want ${LOWEST_REST_VOLTAGE} V or more)`,
      at: match.autoStart,
      evidence: { 'rest voltage, 2 s before auto (V)': round(rest) },
      plot: { signals: ['batteryVoltage'], unit: 'V' },
    }
  },
})
```

## Six steps

1. **Copy the template.** `cp src/rules/_template/new-rule.ts src/rules/<area>/<name>.ts`. Areas so far: `power`,
   `can`, `comms`, `auto`, `mech`, `collision`, `loop`, `vision`, `build`, `alerts`, `battery`.
2. **Fill in the description first.** The comment at the top says what it checks (with the threshold) and why (the
   match and what happened). The app shows four things under every finding, so write them for a student standing
   in the pit:
   - `meaning`: what it probably means, in a sentence or two;
   - `causes`: what could cause it, most likely first, each with what to look for and **where** (a tab in this app,
     a log key in AdvantageScope, a part on the robot, a file in the robot code);
   - `nextStep`: the one thing to do next;
   - `incident`: why the rule exists.

   `who` is who acts: `software` (code, config), `pit` (mechanisms, wiring, batteries), `drive` (drive team, the DS
   laptop).
3. **Write `check`.** Ask the match for what you need; everything you can ask is in `src/rules/view.ts`:

   | You want | Write |
   |---|---|
   | a signal by its name in the robot profile | `match.signal('batteryVoltage')` |
   | a signal by its log key | `match.signal('/Drum/Hood/Voltage')` |
   | its value at a time | `.at(t)` |
   | its lowest / highest value in a window, and when | `.lowest(match.enabled)` → `{ value, at }` |
   | every stretch it was below 7 V while enabled | `.episodes(below(7), { during: match.enabled })` |
   | ...lasting more than 0.3 s | `.episodes(beyond(15), { during: match.enabled, longerThan: 0.3 })` |
   | when a true/false signal turned on | `.turnsOn()` |
   | windows | `match.enabled`, `match.auto`, `match.teleop`, `match.wholeMatch`, `match.before(t, 2)` |
   | "1:47 into the match (teleop; robot time 532.8 s)" | `match.when(t)` |
   | the Driver Station logs loaded with this match | `match.dsLogs` (empty if only the `.wpilog` was dropped) |
   | text (console, git) | `match.text('console').firstMatch(/Rezeroed hood/)` |
   | a signal you can do without (extra evidence) | `match.signalIfLogged('brownoutVoltage')` → the signal, or `null` |
   | gyro pitch in degrees (logged in radians) | `match.signal('gyroPitch').inDegrees()` |

   Each `episode` has `start`, `end`, `seconds`, `peak` (furthest from zero), `lowest` and `highest`.
   Tests for episodes read out loud: `below(7)`, `above(48)`, `beyond(15)` (either way), `isTrue`, `isFalse`.

   To check every motor, camera or device, add `forEach`:

   ```ts
   forEach: 'device',            // or 'motor', 'motorGroup', 'camera', 'mechanism', 'alert'
   check(device, match) {
     const drops = device.connected().episodes(isFalse, { touching: match.enabled })
     if (drops.length === 0) return
     return { message: `${device.name} dropped off CAN ${plural(drops.length, 'time')}`, at: drops[0].start }
   },
   ```

   You never check whether a signal exists. If the log doesn't have it, the engine stops your check and lists the
   rule (or that one device) under "Not checked". If your rule can't judge it for another reason, call
   `match.couldNotCheck('why')` and return; if it checked most of it but had to skip a part, call
   `match.checkedOnlyPart('what was skipped')` and carry on.

   Keep `check` short (about 30 lines; a rule file about 60 besides its description) and write it the way the
   next section says. Name thresholds (`const LOWEST_REST_VOLTAGE = 12.5`), and say in the comment
   whether a threshold was measured or assumed.
4. **Let the log pick the cause, when it can.** If your evidence says which cause fits, return `likely: ['id']`
   (listed first, marked "likely here") or `ruledOut: { id: 'why, in a few words' }`. If the usual next step doesn't
   fit this log, return `nextStep` too. Never tell someone to fetch something that is already loaded: if the
   `.dslog` is in `match.dsLogs`, read it and say what it shows instead. `src/rules/comms/loss.ts` does all three.
5. **Add it to `RULES` in `src/rules/index.ts`** (the order sets the order within a severity: things that cost the
   match first), and **add a test**: a log that must fire it and, if you can, one that must stay quiet. The quick
   way is a few made-up records (a "badness" log, like in `tests/battery-tracker.test.ts`):

   ```ts
   const log = writeWpilog([
     { name: '/DriverStation/Enabled', type: 'boolean', records: [[10, false], [20, true], [35, false]] },
     { name: '/DriverStation/Autonomous', type: 'boolean', records: [[10, true], [35, false]] },
     { name: '/SystemStats/BatteryVoltage', type: 'double', records: [[10, 12.3], [30, 11]] },
   ])
   const report = analyzeFiles([{ name: 'test.wpilog', bytes: log }]).analyses[0].report
   expect(fired(report)).toContain('power/rest-voltage')
   ```

   For a real match, add a cut to `scripts/extract-fixtures.ts`, run `npm run extract-fixtures`, and test it in
   `tests/fixtures.test.ts`. Fixtures are small JSON; never commit a `.wpilog`.
6. **Run `npm test`, then try it on real logs:** `node --experimental-strip-types scripts/check.ts <log.wpilog>`
   prints every finding. Before you change a threshold, run it over every log you have and look at what changes,
   not just the match that made you change it. When you tidy a rule without meaning to change what it finds,
   prove it: `npm run golden -- before.json <log folder>` on the old code, `npm run golden -- after.json <log
   folder>` on yours, then `cmp before.json after.json`.

## How a rule should read

Someone who has never seen this code should be able to read `check` out loud, top to bottom, and say when it
fires. `power/brownout.ts`, `power/margin.ts` and `comms/loss.ts` are written this way; copy their shape.

1. **Guard first.** Return as soon as there is nothing wrong (`if (onsets.length === 0) return`). The rest of
   `check` is only about the problem.
2. **Name the numbers.** One `const` per thing you measured, named for what it is (`lowest`, `deadSeconds`,
   `health`), before you build the answer. Work out each number once, even if the message, the evidence and
   `measured` all show it.
3. **Decide the causes with `if`.** Start with `const likely: string[] = []` and `const ruledOut: Record<string,
   string> = {}`, then one `if` per piece of evidence: `if (rest.low) likely.push('not-full')`. Never a chain of
   `? :` (`a ? x : b ? y : z`): write `if / else if`. One condition choosing between two values is a `? :`, not a
   `let` and an `if`: `nextStep: wedged ? 'Watch the video…' : undefined`.
4. **Evidence is a plain list.** For a line that only sometimes applies, give the value or `undefined`; a value
   left `undefined` is left out. Don't write `...(x ? { 'label': v } : {})`.
5. **Optional signals:** `match.signalIfLogged('name')?.last() ?? NaN`, not `match.has(...) ? match.signal(...) : ...`.
6. **Say numbers the same way everywhere:** `plural(n, 'time')` ("3 times"), `volts()`, `amps()`, `secs()`,
   `pct()`, `round()`, and `totalSeconds(episodes)` for how long episodes lasted.
7. **Long work goes in a named helper below the rule** (the rule's description comes first in the file), as a `function` with a one-line comment saying what it
   answers (`commsLosses(match)`, `dsLogsAround(match, losses)`). Helpers shared by several rules go in their own
   file in the area (`power/battery-health.ts`).
8. **No `!`** (non-null) after a check you already made: keep the checked value in a `const` instead.
9. **One statement per line, lines under ~120 characters.** If a line needs a comment to be understood, split it
   into named steps instead.

### A pit check (Foresight)

A rule that judges the robot sitting disabled in the pit sets `foresightOnly: true` and reads `match.pitStretch`
(the stretch it checks, up to now). It doesn't run on match logs. `src/rules/foresight/motor-temperature.ts` is the
simplest one.

## Things that trip people up

- `/SystemStats/BatteryCurrent` is the roboRIO's own current (~0.5 A), not the battery's. For total current use
  `match.power()` (the sum of the motor supply currents, `src/power/battery-model.ts`).
- Log times are seconds since the robot program started (robot time), not match time. Always say a time with
  `match.when(t)`: it puts match time first and robot time in parentheses, so people can find it in AdvantageScope.
- Values are logged only when they change, so the value at a time is the last one logged before it. `.at(t)`,
  `.episodes()` and `.onGrid()` already do this; don't average between records.
- A problem's identity across matches is the rule plus what it is about (the motor, camera or device for
  `forEach` rules; set `about` yourself otherwise). Keep it stable, or a known issue won't be recognised next time.
- Never wrap `match.signal(...)` in `try`/`catch`: the engine uses the error it throws to list your rule under "Not
  checked". For a signal you can do without, ask `match.has('name')` first.
- A rule that throws shows as "crashed" in the app; it doesn't take the other rules down.
