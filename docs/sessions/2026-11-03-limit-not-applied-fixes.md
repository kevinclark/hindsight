# 2026-11-03: limit-not-applied: the share is the worst motor's (item 3); item 1 held

Brief: `docs/briefs/2026-11-03-limit-not-applied-fixes.md` (80c35e6), items 1 and 3. Both were built, reviewed and
measured. Only item 3 is on main. Item 1 waits on a branch for the maintainer's ruling, because no data covers it
(below). The old open items 2, 4 and 5 stay open; with item 1 they are now items 1 to 4 in the contract's "Open for
the maintainer".

## On main: item 3

- The evidence "share of enabled time over 110 % of the limit (worst motor) (%)" was the largest share of any motor
  in the group. It is now `worst motor`'s own share (LN-13). The share search and its unused `peak` and `start` are
  gone.
- Only `src/rules/power/limit-not-applied.ts` changed in `src/`. No builder change, so the builder backtest doesn't
  apply (AGENTS.md).
- Red, then green: the two rewritten LN-13 tests failed on 827f678 and pass on the fix.
- Two tests were amended, not deleted, because the obligation they proved changed:
  - `[LN-13] the share is the largest share of enabled time any motor spent over 110 %, …` is now
    `[LN-12][LN-13] the share is the worst motor's own, …`. Its expected 2 % is now 1.5 %.
  - `[LN-13] the share is the largest, whichever motor comes first in the profile` is now `[LN-13] the share is the
    worst motor's, whichever place it has in the profile`. Its first case is kept, and a second is added.
- The "strictly 110 %" test now puts a 44 A stretch on the worst motor (Stryker, below).
- The open items were renumbered: old 1, 2, 4 and 5 are now 1 to 4. The pilot note
  (`2026-11-03-limit-not-applied-contract.md`) is a dated record and keeps the old numbers.

## Held: item 1 (a missing Enable flag)

- Branch `claude/limit-missing-enable-flag`, one commit on top of item 3, pushed and not merged.
- The change: a profile limit with no `supplyEnabled`/`statorEnabled` used to read as switched off (amber
  "switched off in code (deliberate?)", `limit-off` likely). On the branch it is not known:
  - no "switched off" words in the title;
  - red, with no cause marked or ruled out, and the rule's own next step;
  - the evidence line `limit switched on in code` reads `not set in the profile`, with no commit after it, because no
    code was read for it (LN-08, LN-09, LN-10, LN-12).
- Five contract tests prove it: four for the supply flag and one for the stator flag. All were red before the
  change.
- **No data covers it**: 0 of 131 findings on the logs below, and 0 of 51 groups in the 8 built-in profiles leave a
  flag out. The maintainer's standing rule is that behaviour no data exercises waits for a real case, and the approval
  came before that count was known, so it went back for a ruling.
- If it lands, these other readers of a missing flag need the same reading. They are not changed anywhere yet:
  - `src/limits/limits-report.ts:81-82` (the Limits tab): `!!L.supplyEnabled`, so a missing flag reads as **off**.
  - `src/ui/Wizard.svelte:108`: `supplyEnabled ? 'on' : 'switched off'` (stator: `'on' : 'off'`), so it shows
    **switched off**.
  - `src/limits/pair.ts:53, 71, 74`: `=== false`, so a missing flag reads as **on**, with Phoenix's default amps when
    the number is missing too.
  - `src/snapshot/report.ts:157`: a robot reporting the supply limit off, against a profile with no flag, is
    `unexpected`: the flag is read as **on**.
  - `src/ui/ProfileBuilder.svelte:284` shows no on/off word for a missing flag: already "not known".

  One shared tri-state reader in `src/profiles/` would make them agree.

## Golden

The same 72 groups before (827f678) and after: 1058 files, 785 unique by content hash, 1050 analysed logs. They hold
778 unique wpilogs, and the only one left out is a macOS `._` resource-fork file. The groups are:
- the app library's copy in `~/.hindsight/app-data-a/library/logs` (47 folders, 807 files: the whole Drive library as
  of its last sync);
- the local test sets under `~/Downloads`;
- the app's own library (9 logs);
- the public logs (21).

Results:
- All rules: 9160 findings before and 9160 after. 0 differences outside `power/limit-not-applied`.
- limit-not-applied: 131 findings before and 131 after, on 47 distinct log files. 115 are unchanged.
- 16 findings changed, only in the share, and each one fell: the motor with the largest share wasn't `worst motor`.
  They are 4 distinct logs, copied across folders:

  | Group, worst motor | Share before (%) | Share after (%) |
  |---|---|---|
  | 2026 offseason Flywheel supply, leader | 6.4 | 4.4 |
  | 2026 offseason Flywheel supply, leader | 6 | 3.9 |
  | 2026 offseason Flywheel supply, leader | 4.8 | 4.5 |
  | 2026 offseason Drive supply, front-left drive | 3.3 | 3.1 |

- Item 3 alone (`0231534`) and items 1 and 3 together give byte-identical golden output, both before and after the
  review folds. Item 1 changes no finding in this data.
- Golden ran without `--code`, so no log had a current-limit lines comparison. That is the same on both sides, and
  neither fix reads the comparison.

## Mutation (Stryker 9.6.1, contract file alone)

- Run the contract tests once first: a cold Vite cache crashes the workers with ENOTEMPTY.
- Main (item 3): 189 mutants. 188 were caught: 184 killed, 3 timeouts and 1 runner error (LN-21's flickering CAN).
  1 survived, the recorded `>` → `>=` equivalent on the empty-piece filter (L149). 37 tests, all 37 kill something,
  and 16 have a unique kill.
- Items 1 and 3 together: 196 mutants, 195 caught and the same 1 survivor. 42 tests, 15 with a unique kill.
- On the first build (d1b5fa7) a second mutant survived: `beyond(limit * 1.1)` → `limit / 1.1` in the share. The
  "strictly 110 %" test had put its 44 A stretch on the right motor, which the share no longer reads. With a 44 A
  stretch on the worst motor, the mutant fails it (checked by hand, then by Stryker).
- The 13 equivalents recorded in the old share search are gone with that code. The contract's "Equivalent mutants"
  now lists the one left.
- No whole-suite Stryker run. Every non-contract test had 0 unique kills on this file in the pilot, and only the
  contract file's tests changed.

## Review

A Fable reviewer (`general:reviewer`) and `code-review` (high, all findings) reviewed both items (827f678..d1b5fa7)
at the same time. Fable saw code-review's list only after its own report, then graded it. Its verdict: go with
changes, no defect.
- Fixed, evidence-based:
  - The contract's equivalents list described the deleted share search.
  - Item 1's tests covered only `supplyEnabled`; a stator case is added on the item-1 branch.
  - The Stryker survivor above.
  - My own slip: a test named `[LN-12, LN-13]` didn't match contract-check's `[ID][ID]` pattern, so it proved neither
    id. It is now `[LN-12][LN-13]`.
- Fixed, judgment:
  - On the item-1 branch: the share, `off` and the yes/no words are named consts (CONTRIBUTING "Name the numbers",
    no nested `? :`).
  - Two contract lines of 178 and 183 characters are rewrapped.
- No change:
  - No commit after `not set in the profile`. Fable judged it right: no commit was read for it.
  - The second `enabledAndConnected` call for the share: negligible.
  - Saved summaries keep their old share until reread. The keys are unchanged, so `SUMMARY_SHAPE` stays.
  - code-review flagged the two amended LN-13 tests under the "delete no test" rule. Fable graded it not real: the
    approved fix removed the obligation they asserted. They are named above.
- Follow-up: the other readers of a missing flag (item 1, above).

## Landing checks

On `git archive` of the item-3 tip with `npm ci`: the whole suite passed, `npm run check` gave 0 errors,
contract-check reported every obligation met, and the `contracts` CI ran on the pushed branch.

## Commands

Scratch copies: `git archive <sha> | tar -x -C <dir>`, then `npm ci --ignore-scripts`.

```
npm run golden -- before.json <the 72 groups>        # in the 827f678 copy; groups are folders, plus one comma list
npm run golden -- after.json  <the same 72 groups>   # in the fix's copy; ~150 s a side
npm i -D --no-audit --no-fund @stryker-mutator/core@9 @stryker-mutator/vitest-runner@9
npx vitest run --config vitest.contract.config.ts     # warm the Vite cache first (ENOTEMPTY otherwise)
npx stryker run stryker.contract.json                 # the pilot note's config, with the contract vitest config
python3 scripts/contract-check
```

The per-finding comparison reads both JSON files and keys each log by (group, file, index). It requires everything
outside `power/limit-not-applied` to be identical, and lists the evidence keys that changed in each finding.
