# Brief: fix two defects in power/limit-not-applied (open items 1 and 3)

The maintainer approved this on 2026-11-03. The contract `docs/contracts/limit-not-applied.md` lists five behaviours
under "Open for the maintainer". Its review called items 1 and 3 defects, not choices. This session fixes those two
only. Items 2, 4 and 5 stay open; don't touch them.

Read first: `docs/contracts/limit-not-applied.md` (the whole file), `docs/sessions/2026-11-03-limit-not-applied-contract.md`,
AGENTS.md ("Landing a branch", "Rules"), CONTRIBUTING.md ("How a rule should read"), and the skills
`general:regenerable-contract` and `general:code-standards` ("When a bug is found").

## The two defects

1. **A profile limit with no Enable flag reads as switched off.** `check()` in `src/rules/power/limit-not-applied.ts`
   takes `isOn` straight from `group.limits.supplyEnabled` / `statorEnabled`, so `undefined` is falsy. The result is
   an amber "switched off in code (deliberate?)" title, `limit-off` as the likely cause, and the switched-off next
   step. That says the code switched the limit off, which nobody read. Phoenix 6 defaults both Enable flags to true
   (AGENTS.md, "Profile builder"), and `src/builder/code-draft.ts` leaves the flag out when the code has no Enable
   line.
   - ➡️ Recommended fix: treat a missing flag as **not known**, like the "ran other code" path (LN-09, LN-10):
     - no "switched off" words in the title;
     - the default severity (error), not amber;
     - `limit-off` neither likely nor ruled out;
     - the evidence line `limit switched on in code` reads `not set in the profile` (fix those words in LN-12).
   - Don't read a missing flag as "on". The profile may be hand-written, and ruling out `limit-off` "because the
     limit is switched on in the code" would claim a line nobody read.
   - If you think "on" is right, put both options to the parent session with the golden numbers before building
     either.
2. **The share labelled "(worst motor)" can come from another motor.** `shareOverLimit()` returns the largest share
   over the group's motors. The evidence key says `(worst motor)`, which is the motor with the longest run over
   120 %.
   - ➡️ Recommended fix: compute the share for `worst.motor` itself, so the key keeps its name and becomes true.
     Changing the label would change an evidence key that LN-12 fixes word for word, and the saved summaries
     (`SUMMARY_SHAPE`, AGENTS.md "Session summaries") may carry it.
   - Remove the code the change leaves dead: `peak` and `start` of the share are already unused.

## Steps

1. For each defect, amend the obligation first: LN-09, LN-10 and LN-12 for item 1; LN-12 and LN-13 for item 3.
   Write the contract test that carries the id, and show it **red on the current code**: the defect is live, so the
   commit subject starts `fix:`. Then make the change and show it green. Delete item 1 and item 3 from "Open for the
   maintainer" and renumber the rest.
2. Change only `src/rules/power/limit-not-applied.ts`.
   - The Limits tab reads a missing flag the same way (`src/limits/limits-report.ts`), and so may `src/limits/pair.ts`,
     `src/snapshot/report.ts`, `ProfileBuilder.svelte` and `Wizard.svelte`.
   - List each reader you find in the session note as a follow-up, with what it shows for a missing flag. Don't change
     them here.
3. `npm run golden -- before.json <log folders…>` at the base commit, then `after.json` at the tip, over **every
   log you have**: the log library and the public logs, the same folders on both sides. Compare them with `cmp`.
   - Expected: item 1 changes nothing, because none of the 51 groups in the 8 built-in profiles leaves a flag out
     (2026-11-03).
   - Item 3 changes the share value only on findings where the motor with the largest share isn't `worst motor`.
   - Read every changed finding and report the count, plus one example per kind of change. Any change you didn't
     expect stops the work: report it.
   - If you can't find the log folders, ask the parent session for them; don't run golden on a sample.
4. The builder backtest: AGENTS.md asks for it only for builder changes. This brief makes none, so skip it and say
   so. If you do touch `src/builder/`, run `scripts/builder-backtest.ts` before and after on every library and public
   log, and read every changed line.
5. Mutation check. Run the contract tests once first: a cold Vite cache makes the 8 Stryker workers crash at
   start-up with ENOTEMPTY (a rename under `node_modules/.vite`). Then run Stryker on the rule with the contract file
   alone, using the recipe in the session note: 5 s to 1 min. The run must show no new survivors beyond the 14
   recorded equivalents, or else record each new one. A whole-suite run (~55 min) isn't needed unless the
   contract-only and whole-suite kill sets could now differ.
6. Review before landing. In the background, a fresh-context Fable reviewer (`general:reviewer`) and Skill
   `code-review`, args `high --max-findings all` (never `--fix`). Fable doesn't see code-review's list until it has
   reported; then send it the list to grade. Fold in the findings, re-run steps 3 and 5 if the code changed, and
   re-report the findings with their outcomes.
7. Land per AGENTS.md:
   - push the branch; `contracts` CI must be green on the tip;
   - run `npx vitest run` and `npm run check` on `git archive <tip> | tar -x` (with a complete `node_modules`);
   - `git merge --no-ff` into main; push.
   - Commit with pathspecs only: other sessions share this repository.

## Rules

- **Public repository.** Synthetic fixtures only, with no names, teams, private content or real serial numbers, in
  code, tests, docs and commit messages alike. Golden output stays out of the repository; report counts and made-up
  examples.
- Delete no test without the maintainer's approval by name.
- The "How a rule should read" style applies to every line you add to the rule.

## Done means

- Items 1 and 3 are fixed, with red-then-green contract tests, and gone from "Open for the maintainer".
- `scripts/contract-check` shows every obligation met.
- Golden is compared on every log, with each changed finding read and counted.
- Contract-only Stryker leaves no unexplained survivor.
- The review is folded in, and the branch is merged `--no-ff` into main with CI green.
- A session note in `docs/sessions/` holds the exact commands, the before/after numbers and the follow-up readers
  from step 2.
- Report to the parent session: the merge sha, the golden counts, the Stryker numbers and the follow-ups.
