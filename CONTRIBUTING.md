# Adding a rule

Every rule is one small file that answers one question about a match ("did the robot brown out?"). When something
goes wrong at an event, the fix is not just in the robot code: it becomes a rule, so the next match is checked for
it without anyone having to remember.

## Five steps

1. **Copy the template.** `cp src/rules/_template.ts src/rules/<area>/<name>.ts`. Areas so far: `power`, `can`,
   `comms`, `auto`, `mech`, `collision`, `loop`, `vision`, `build`, `alerts`, `battery`.
2. **Write the doc comment first.** What it checks (with the threshold), why (the match and what happened, with a
   link to the write-up), and what a student should do when it fires. Fill in `fix` and `incident` with the same
   words: the app shows them under every finding. Set `audience` to who acts on it: `software` (code, config),
   `pit` (mechanisms, wiring, batteries), `drive` (drive team, DS laptop); the Match tab filters by it.
3. **Write the check.** Get signals with `num(m, key)` (numbers, booleans as 0/1) or `values(m, key)` (strings,
   arrays, poses). Take keys from the profile (`m.profile.signals...`, `m.profile.motorGroups`), never typed into
   the rule. List the keys you can't run without in `needs`, so a log without them shows the rule under "Not
   checked" instead of silently passing. A rule that loops over several motors or cameras returns
   `withMissing(findings, missingKeys, total)` (in `helpers.ts`) so a missing device shows as "partly checked". Values are logged only when they change: use `valueAt` / `resample` from
   `src/match/series.ts`, which hold the last value. Never interpolate. Keep it under ~60 lines; if it grows, move a
   helper into `src/rules/helpers.ts`.
4. **Add it to `RULES` in `src/rules/index.ts`** (the position sets the order within a severity: things that cost
   the match first), and **add a test** with a log that must fire it and, if you can, one that must stay quiet:
   - quick: a few synthetic records with `writeWpilog` (see `tests/battery-tracker.test.ts`)
   - from a real log: add a cut to `scripts/extract-fixtures.ts`, run `npm run extract-fixtures`, and test it in
     `tests/fixtures.test.ts`. Fixtures are small JSON; never commit a `.wpilog`.
5. **Run `npm test`, then check the real logs.** `node --experimental-strip-types scripts/check.ts <log.wpilog>`
   prints every finding. Before you change a threshold, run it over every log you have and look at what changes,
   not just the match that prompted it.

## Things that trip people up

- `/SystemStats/BatteryCurrent` is the roboRIO's own current (~0.5 A), not the battery's. Total current is the sum
  of the motor supply currents (`buildPowerGrid` in `src/power/battery-model.ts`).
- Log time is seconds since the robot program started, not match time. `when(m, t)` in `helpers.ts` turns it into
  "532.8 s (teleop, 17.7 s left)".
- Severity: `error` means it cost or nearly cost a match, `warning` means a margin is eroding, `info` is context.
- A rule that throws shows up as "crashed" in the app; it doesn't take the other rules down.
