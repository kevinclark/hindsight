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
  fix: 'Put a battery reading 12.5 V or more at rest on the robot.',
  incident: 'CalGames 2026 Q21: 12.44 V before auto',

  check(match) {
    if (match.autoStart === null) return
    const rest = match.signal('batteryVoltage').median(match.before(match.autoStart, 2))
    if (rest >= LOWEST_REST_VOLTAGE) return          // all good: return nothing
    return {                                          // something's wrong: say what, with the numbers
      message: `Battery rested at ${volts(rest)} before auto (want ${LOWEST_REST_VOLTAGE} V or more)`,
      at: match.autoStart,
      evidence: { 'rest voltage, 2 s before auto (V)': round(rest) },
      plot: ['batteryVoltage'],
    }
  },
})
```

## Five steps

1. **Copy the template.** `cp src/rules/_template/new-rule.ts src/rules/<area>/<name>.ts`. Areas so far: `power`,
   `can`, `comms`, `auto`, `mech`, `collision`, `loop`, `vision`, `build`, `alerts`, `battery`.
2. **Fill in the description first.** The comment at the top says what it checks (with the threshold) and why (the
   match and what happened). `fix` and `incident` are what the app shows under every finding, so write them for a
   student standing in the pit. `who` is who acts: `software` (code, config), `pit` (mechanisms, wiring,
   batteries), `drive` (drive team, the DS laptop).
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
   | "532.8 s (teleop, 17.7 s left)" | `match.when(t)` |
   | text (console, git) | `match.text('console').firstMatch(/Rezeroed hood/)` |

   Each `episode` has `start`, `end`, `seconds`, `peak` (furthest from zero), `lowest` and `highest`.
   Tests for episodes read out loud: `below(7)`, `above(48)`, `beyond(15)` (either way), `isTrue`, `isFalse`.

   To check every motor, camera or device, add `forEach`:

   ```ts
   forEach: 'device',            // or 'motor', 'motorGroup', 'camera', 'mechanism', 'alert'
   check(device, match) {
     const drops = device.connected().episodes(isFalse, { touching: match.enabled })
     if (drops.length === 0) return
     return { message: `${device.name} dropped off CAN ${drops.length} times`, at: drops[0].start }
   },
   ```

   You never check whether a signal exists. If the log doesn't have it, the engine stops your check and lists the
   rule (or that one device) under "Not checked". If your rule can't judge it for another reason, call
   `match.couldNotCheck('why')` and return; if it checked most of it but had to skip a part, call
   `match.checkedOnlyPart('what was skipped')` and carry on.

   Keep a rule under ~60 lines. Name thresholds (`const LOWEST_REST_VOLTAGE = 12.5`), and say in the comment
   whether a threshold was measured or assumed.
4. **Add it to `RULES` in `src/rules/index.ts`** (the order sets the order within a severity: things that cost the
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
5. **Run `npm test`, then try it on real logs:** `node --experimental-strip-types scripts/check.ts <log.wpilog>`
   prints every finding. Before you change a threshold, run it over every log you have and look at what changes,
   not just the match that made you change it.

## Things that trip people up

- `/SystemStats/BatteryCurrent` is the roboRIO's own current (~0.5 A), not the battery's. For total current use
  `match.power()` (the sum of the motor supply currents, `src/power/battery-model.ts`).
- Times are seconds since the robot program started, not match time. Use `match.when(t)` in messages.
- Values are logged only when they change, so the value at a time is the last one logged before it. `.at(t)`,
  `.episodes()` and `.onGrid()` already do this; don't average between records.
- A problem's identity across matches is the rule plus what it is about (the motor, camera or device for
  `forEach` rules; set `about` yourself otherwise). Keep it stable, or a known issue won't be recognised next time.
- Never wrap `match.signal(...)` in `try`/`catch`: the engine uses the error it throws to list your rule under "Not
  checked". For a signal you can do without, ask `match.has('name')` first.
- A rule that throws shows as "crashed" in the app; it doesn't take the other rules down.
