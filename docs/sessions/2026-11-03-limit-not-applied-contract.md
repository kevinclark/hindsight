# 2026-11-03: contract and kill matrix for `src/rules/power/limit-not-applied.ts`

Brief: `docs/briefs/2026-11-03-limit-not-applied-contract.md`. Convention: skill `general:regenerable-contract` v2
(plugin 0.60.194). This is the first TypeScript/vitest unit; focus (JS) and ha-pwrcell (Python) came first. Branch
`claude/brave-goldstine-2b6ba6` from `1f77fad`. Every mutation run used a scratch copy (`git archive | tar -x`), never
the checkout. **The rule itself is unchanged**, so golden and the builder backtest don't apply (AGENTS.md).

**Result.** `docs/contracts/limit-not-applied.md` has 21 obligations, LN-01 to LN-21. `scripts/contract-check` reports
all of them met, locally and in the new `contracts` CI job. Measured with Stryker 9.6.1 on the rule's 218 mutants:
- Baseline, whole suite: 121 caught (55.5 %).
- Contract file alone: 204 caught (93.6 %).
- Final, whole suite: 204 caught (93.6 %), the identical set the contract file alone catches.

The mutants left are the 14 recorded equivalents, so 0 survivors are unexplained. Drill round 1 rebuilt the rule from
the contract and passed 35 of 36 contract tests on its first run, a contract defect, now fixed. Round 2 passed 36 of
36 with nothing new to add, and the whole suite passed on its rebuild. Five behaviours are left open for the
maintainer (below), each a likely defect or a judgment call. None is pinned by a test.

## Before / after

| | Baseline (`1f77fad`) | Contract file alone (`6681e8d`) | Final, whole suite (`6681e8d`) |
|---|---|---|---|
| Mutants (Stryker 9.6.1, this file only) | 218 | 218 | 218 |
| Caught | 126 (57.8 %): 121 killed, 5 crashed the runner | 204 (93.6 %): 200 killed, 3 timed out, 1 crashed | 204 (93.6 %): 199 killed, 5 crashed the runner |
| Survived / no coverage | 86 / 6 | 14 / 0 | 14 / 0 (the same 14) |
| Survivors not recorded as equivalent | 92, none read yet | 0 | 0 |
| Tests run against the file / with any kill / with a unique kill | 1278 / 35 / 10 | 37 / 37 / 16 | 1315 / 72 / 15 (all 15 contract tests) |
| Stryker wall time, 8 workers (CPU, user) | 57 min 27 s (24,822 s) | 47.6 s (148 s); 5.1 s before LN-21 | 54 min 36 s (25,484 s) |

Notes on the numbers:
- "Caught" counts the 3 timeouts and the 1 out-of-memory crash, because each is LN-21's test detecting that mutant:
  without the empty-piece filter, the window pieces double with every drop. The skill says "timeout mutants are not
  kills of any test". By that rule, 200 (91.7 %) were killed by a named test.
- Wall times are inflated: other sessions ran their own mutation runs on this Mac, with load averages of 20 to 46 on
  18 cores. Compare the CPU times in the logs, not the wall times.
- Each run's "tests run against the file" is what Stryker's vitest runner counted as related to the file. The
  whole suite has 1805 tests at `1f77fad` and 1842 at `6681e8d`.
- The 5 mutants that crash the runner are the same 5 in the baseline and the final run: the ones that drop or break
  the empty-piece filter (L146–149, #155, #159, #161, #163, #166). In the whole suite, some test's log has enough
  Connected drops to run a worker out of memory. The old suite caught them only that way, with no named test, and
  LN-21 now names it.
- The baseline had 6 mutants with no coverage, all on lines 76–78: the branch for "switched on, in the profile's code"
  (`likely: ['not-saved', 'default-limit']`). No old test ran it. Drill round 1 failed on exactly that case.
- Joint check: the contract file alone catches the identical 204 mutants as the whole suite and leaves the identical
  14 survivors, so no other test is needed for kills. Every non-contract test has 0 unique kills.

## Step 0: Stryker on vitest

- **`killedBy` with `disableBail: true` is the per-test kill matrix**, so `killmatrix.py` isn't needed for vitest.
  Config: `testRunner: "vitest"`, `coverageAnalysis: "perTest"`, `disableBail: true`, `reporters: ["json"]`. In the
  baseline, 0 killed mutants had an empty `killedBy`. A mutant killed by k tests lists all k: the most-killing test
  has 66 kills; 76 of the 121 killed mutants were killed by more than one test, 45 by exactly one.
- **Where the 57 minutes went.** Stryker flagged 201 of 218 mutants (92 %) as *static*: covered outside any test.
  For each of those it runs every related test (1149 per mutant on average, against 1278 related). The cause is in
  the test files, not in the rule: at least 10 test files call `analyzeFiles(...)` in a `describe` body or at module
  level, which runs while tests are collected. Examples: `tests/rule-format.test.ts:18`,
  `tests/review-fixes.test.ts:46`, `tests/datalogmanager.test.ts:218`. Every rule's `check` then counts as covered
  outside a test. The contract file builds its logs inside each test, so its run takes seconds. Moving those
  analyses into `beforeAll` doesn't help, because that also runs outside a test. They would have to move into the
  tests.
- **Trap: `mergeConfig` appends to arrays.** A vitest config for the contract file alone, written as
  `mergeConfig(base, { test: { include: [contract] } })`, still ran the whole suite (1311 tests). Use a spread:
  `{ ...base, test: { ...base.test, include: [contract] } }`, then `"vitest": { "configFile": … }` in the Stryker
  config.
- **Trap: this worktree's `node_modules` was incomplete.** With it, `npx vitest run` fails 11 tests in 9 files on
  `main` too, and `npm run check` reports 67 errors. An `npm i` in the scratch copy fills it in: the whole suite then
  passes 1805, and the check reports 0 errors. Use a copy whose `npm i` has run.

## Contract, tests, contract-check

- `docs/contracts/limit-not-applied.md`: intent, interface (the rule and the collaborators it may use), two defined
  terms ("ran the pinned commit", "ran the profile's code"), and 21 obligations.
  - By kind: 2 compatibility, 4 failure mode, 14 behaviour, 1 non-functional.
  - Also: fixed wording (title, next step, evidence labels, not-checked lines), what each cause id means, unspecified
    by design, ruled out, 5 open items, and 14 equivalents.
- `tests/limit-not-applied.contract.test.ts`: 37 tests. It imports the rule, the runner (`runRules`, `motorGroup`),
  `buildMatch`, the wpilog reader and writer, and a built-in profile's key layout. The robot is made up: one group,
  "Roller", of two motors, and the logs are synthetic. The rule runs alone through `runRules`, so each test checks the
  finding or the "not checked" line a student would see.
- `scripts/contract-check`: the ha-pwrcell version (stdlib Python), changed in three ways:
  - It reads vitest JUnit names, where describe names are joined by ` > `.
  - An obligation counts as retired only when its text starts with "Retired".
  - Its docstring names no other repository.
- Proof that contract-check fails when it should: on a doctored copy of the test file it reported a failing test
  (FAILING), a `test.skip` (FAILING), an id with no test (UNPROVEN) and an unknown id (UNKNOWN), with "all met: False".
- CI: `.github/workflows/contracts.yml` runs `npm ci --ignore-scripts` and then `python3 scripts/contract-check` when
  `src/**`, `tests/**`, `docs/contracts/**` or `package*.json` change. Run 41635864863 on `6681e8d` was green, with 21
  of 21 met. AGENTS.md "Landing a branch" now says so.

## Survivors became obligations

From the first contract-only run (47 survivors, 171/218), each became a test that is green on the live code and red
on its mutant, or an equivalent:
- 26 descriptor mutants (empty prose, empty sources and thresholds) became **LN-19**: every prose field is said, there
  are two measured thresholds, and the cited pages come from `sources.ts`. That test has 27 unique kills.
- `if (error instanceof MissingSignal)` → `true` became **LN-20**: any other error is not swallowed. Mutant #149.
- The share's motor loop (`||` → `&&`, `<=` → `false`) became a new LN-13 test, where the first motor has the
  larger share. Mutants #182 and #185.
- `if (limit === undefined) continue` → `false` became an LN-03 case: a kind with no limit isn't read, so its
  missing key changes nothing. Mutant #64. I had listed it as equivalent by reasoning, and the run disproved that.
- The review added **LN-21**: a flickering Connected flag costs time in proportion to the drops. Measured on the
  mutant with the filter removed: 20, 22 and 24 drops took 446, 1751 and 7972 ms, and 26 ran out of memory. The live
  rule takes 1 ms. Mutants #155, #159, #161 and #163 now time out or crash. I had listed #155 and #163 as equivalent.
- 14 equivalents are recorded with reasons in the contract. 13 sit on paths a finding can never take (the share
  when no motor was over 110 %, or the share stretch's unused `peak` and `start`). The 14th is `>` → `>=` on the
  piece filter: it keeps zero-length pieces, which don't multiply.

## Drill

Each round used an empty directory with no `.git`: `package*.json`, the TS and vite configs, `src/` with the rule
replaced by a 5-line stub, `tests/helpers/`, the contract tests, the contract, ADR 8, CONTRIBUTING.md and the
"Landing" and "Rules" sections of AGENTS.md. A fresh Sonnet implementer rebuilt the rule. It read no test before its
first run and copied its file before running, so the first run is kept as it was.

- **Round 1** (contract at `eb2ce9b`): 35 of 36 passed on the first run. `[LN-10]` failed because LN-10 said "ran the
  profile's code" through a back-reference to LN-09, while LN-11 used a similar phrase for the narrow case.
  - With this rebuild, the whole suite gave 1840 passed and 1 failed (that test): **no older test covers this case**.
  - Reading its code turned up a second gap. The contract left the cause prose free, and the rebuild redefined
    `default-limit` as "a later config call replaced the limit".
  - Fix (`e25ff92`): two terms, each defined once and used throughout, and what each cause id means.
- **Round 2** (contract at `e25ff92`): 36 of 36 on the first run, and the whole suite passed 1841 with 0 failures.
  - It logged no question that changes a result.
  - Its one numeric difference, `Math.round(peak)` against the live `+peak.toFixed(0)`, agreed on all 8,000,000
    sampled values (including x.5 ± 1e-13).
  - After the review's additions it also passes all 37 tests at `6681e8d`, LN-21 included. Round 1's rebuild still
    fails only LN-10.

## Review

A fresh Fable reviewer and `code-review` (high, all findings) ran on `1f77fad..e25ff92`, and Fable graded
code-review's list.
- Folded in `6681e8d`, evidence-based:
  - LN-21. Removing the empty-piece filter is not equivalent.
  - Open item 5. A profile with no pinned commit (`toProfile` gives `sha: ''`) matches every log.
  - The `worst = {}` equivalent's stated reason was wrong.
  - LN-16 now gives all three missing-signal lines.
  - LN-11 says "used", not "read".
  - LN-12's unreachable "left out" clause is gone.
  - contract-check's `Retired` match and ` > ` names are fixed.
- Folded in `6681e8d`, judgment:
  - contract-check's docstring no longer names other repositories.
  - The AGENTS.md CI paragraph.
- One finding needed no change: a workflow file can't be pushed without the `workflow` scope. The push of
  `6681e8d` carried it.

## For the maintainer

1. **Open items 1 to 5** (the contract's "Open for the maintainer"). Today's behaviour, unpinned, each with evidence:
   - (1) A limit with no Enable flag in the profile reads as "switched off (deliberate?)". AGENTS.md says Phoenix 6
     defaults Enable to true, and the builder leaves the flag out when the code has no Enable line. 0 of the 51
     groups in the 8 built-in profiles have this, so no data covers it.
   - (2) When one motor's stator key is missing, the group's supply finding is lost too: the whole group is "not
     checked".
   - (3) The share labelled "(worst motor)" can be another motor's.
   - (4) The 0.2 s line sits near the limiter's measured 0.208 s burst, which was measured above 110 %, not 120 %.
   - (5) An empty pin matches every log.

   The reviewer judged (1) and (3) plain defects. Each fix changes the rule and its golden output, so it is its own
   change.
2. **Deletion candidates (6; nothing deleted).** Each has 0 unique kills in the final run. Each tests only this rule,
   and the contract tests prove what it proves. The joint check above covers all of them together.
   - `tests/power-rules.test.ts` › `power/limit-not-applied: the share of time over the limit` › `is evidence only: 3 %
     of the enabled time over 110 % with no run over 120 % for 0.2 s gives no finding` (LN-13)
   - `tests/power-rules.test.ts` › `power/limit-not-applied: a current held after the motor dropped off CAN` › `is not
     the motor drawing it` (LN-06)
   - `tests/severity-rules.test.ts` › `power/limit-not-applied severity` › `the profile has a group with the limit on in
     code and one with it off` (a fixture precondition for the next three; 0 kills)
   - … › `a limit that is on in code and still exceeded stays an error` (LN-09)
   - … › `a limit switched off in the code this log ran is a warning, and the message says why` (LN-08, LN-09)
   - … › `when the log ran other code than the profile's, "off" is not known for it, so it stays an error` (LN-09)

   Kept on their own merits, though also 0 unique: `tests/limit-lines.test.ts` (the code-folder and GitHub comparison,
   `compareMatchLimits`, caching), `tests/team-logs.test.ts` and `tests/review-fixes.test.ts` (other units and real
   logs). The 6 above run on the built-in 2026 offseason profile, so they also show the incident's real Flywheel
   group: if that matters to you, keep the second and fourth.

## What the skill should change for TypeScript/vitest

1. **Runner:** `@stryker-mutator/vitest-runner` with `coverageAnalysis: "perTest"` and `disableBail: true`. Its JSON
   `killedBy` is the per-test kill matrix: drop `killmatrix.py` and the command runner for vitest.
2. **Static mutants decide the cost.** If any test file runs the unit's code at collection time (a `describe` body or
   module level), Stryker marks the unit's mutants static and runs every related test for each one. Here that was 57
   min, against 5 s for the contract file alone. Iterate on the contract file alone; run the whole suite only for the
   baseline and the final run. The contract-only run (5 to 48 s) is cheap enough for PRs.
3. **A contract-only vitest config:** `{ ...base, test: { ...base.test, include: [file] } }`. `mergeConfig` appends
   to `include`, so the whole suite still runs.
4. **Timeouts and crashes can be the detection.** For a non-functional obligation (LN-21, linear time), the mutant
   hangs or runs out of memory instead of failing an assertion. Give that test its own short limit
   (`test(name, fn, 5_000)`) and report "killed by a named test" separately from "caught".
5. **"Free wording" still has an obligation: that it is said.** The descriptor's prose was 26 of the 47 first
   survivors. One test that every prose field is non-empty and every cited page is from the catalog (LN-19) killed
   all of them, instead of recording 26 equivalents.
6. **Free prose doesn't mean free meaning.** A rebuild redefined a cause id's meaning. When code marks ids
   (`likely`, `ruledOut`), the contract fixes what each id means.
7. **Define each term once.** Round 1's only failure was one phrase ("ran the profile's code") meaning two things in
   two obligations. Add a short "terms" block before the obligations.
8. **Reasoned equivalents were wrong 2 times out of 2 here.** `if (limit === undefined) continue` and the
   empty-piece filter both looked equivalent and were not: the first was killed by a test, the second ran out of
   memory. This repeats the skill's rule (equivalents come from the run).
9. **Test through the runner, not with fakes.** The contract tests run the rule alone through `runRules`, on
   synthetic wpilog bytes and a synthetic profile. That proves what the student sees (titles, not-checked lines), and
   it let the drill run the rule's real collaborators unchanged.
10. **contract-check for vitest:** JUnit names join describe names with ` > `; take the ids from the first part that
    has them. An obligation is retired only when its text starts with "Retired".

## Commands (re-derivable)

Scratch copy `C` = `git archive <sha> | tar -x -C C`, plus a `node_modules` on which `npm i` has run, plus:

```
npm i -D --no-audit --no-fund @stryker-mutator/core@9 @stryker-mutator/vitest-runner@9      # 9.6.1
```

`stryker.config.json` for the whole suite:

```json
{ "testRunner": "vitest", "mutate": ["src/rules/power/limit-not-applied.ts"], "coverageAnalysis": "perTest",
  "disableBail": true, "reporters": ["json", "clear-text", "progress"],
  "jsonReporter": { "fileName": "reports/mutation/mutation.json" }, "concurrency": 8, "timeoutMS": 60000 }
```

For the contract file alone, the same plus `"vitest": { "configFile": "vitest.contract.config.ts" }` and its own
`jsonReporter` file, with:

```ts
import base from './vite.config.ts'
export default { ...base, test: { ...base.test, include: ['tests/limit-not-applied.contract.test.ts'] } }
```

Then `npx stryker run [stryker.contract.json]`. Per-test kills, unique kills and survivors come from the JSON report's
`killedBy`; a test has a unique kill when it is the only entry in a mutant's `killedBy`. `contract-check`:
`python3 scripts/contract-check`. Landing checks: `npx vitest run` and `npm run check` on the archive of the tip.
