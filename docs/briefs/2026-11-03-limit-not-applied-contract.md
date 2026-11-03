# Brief: contract + kill matrix for `src/rules/power/limit-not-applied.ts` (2026-11-03)

The maintainer wants every repo to adopt the regenerable-contract convention (2026-11-02, "apply this everywhere"). The method
is the skill `general:regenerable-contract` (v2, plugin 0.60.191): read it first. It was proven on one JS unit
(focus, 73.3 → 96.4 % of mutants caught) and one Python unit (ha-pwrcell, 77.0 → 97.0 %). This is the first
TypeScript/vitest unit.

## Why this unit
- 185 lines, one rule, 6 of its 22 commits in 180 days were review or fix passes.
- Its header already states its obligations with reasons (120 % for more than 0.2 s, amber vs red by commit, the
  2026 offseason measurements). The contract starts from that header and the rule-format ADRs.
- Its tests are spread over about 10 files (`tests/power-rules.test.ts`, `limits.test.ts`, `limit-lines.test.ts`,
  `review-fixes.test.ts`, …). That is the "feature-wide test file" problem the skill warns about, and the reason the
  contract tests go in their own file.

## Steps (proof for each in `docs/sessions/2026-11-03-limit-not-applied-contract.md`)
0. **Baseline** in a scratch copy (`git archive HEAD | tar -x`, never this checkout): Stryker 9 with
   `@stryker-mutator/vitest-runner`, mutating this file only. Measure first whether Stryker's own JSON `killedBy`
   with `disableBail: true` gives the per-test kill matrix. If it does, record that it replaces `killmatrix.py` for
   vitest. If not, use the command runner plus `docs/tools/killmatrix.py` from claude-skills.
1. **Contract**: `docs/contracts/limit-not-applied.md` with ids `LN-01…`, kinds, fixed wording (finding text that
   users see is probably fixed: decide and write it out), unspecified by design, ruled out, equivalents.
2. **Contract tests** in `tests/limit-not-applied.contract.test.ts`, importing only the rule and its declared
   collaborators. Port `scripts/contract-check` from `~/code/ha-pwrcell/scripts/contract-check` (vitest
   `--reporter=junit --outputFile={junit}`). A skipped test is not a proof.
3. **Survivors**: each becomes an obligation + test (green now, red on that mutant, both shown) or an equivalent
   with its reason.
4. **Re-measure** whole suite and contract file alone. List deletion candidates by name for the maintainer; delete nothing.
5. **Drill** (at most 2 rounds), per the skill: an empty directory, the first run is the score, and each logged
   question is probed on the live code and on the rebuild.
6. Land per `AGENTS.md` ("Landing a branch"): CI green on the branch tip, then `git merge --no-ff`. Commit with
   pathspecs. Write the session note with what the skill should change for TypeScript/vitest.

## Rules that bind here
- This repo is public: synthetic fixtures only, nothing private in code, docs or commit messages (`AGENTS.md`).
- The golden and backtest checks in `AGENTS.md` apply only if the rule's code changes. This pilot should not
  change it; if it must, say why and run them.

## Done means
The contract is committed, `contract-check` reports every id met (and runs in CI), there are 0 unexplained
survivors, a drill round passes with nothing new, and a before/after table: caught %, tests, unique kills, wall time.
