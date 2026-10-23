# 2026-10-22/23: GitDirty's "Uncomitted changes" spelling

## Handoff

- leftovers: none
- repos:
  - hindsight (`/Users/kev/code/makers/hindsight/.claude/worktrees/logging-tab-cf4e65`, branch
    `claude/build-dirty-spelling`, which fast-forwards to main): stage only `AGENTS.md`; message
    "AGENTS.md: read GitDirty only through isUncommitted() (older AdvantageKit writes 'Uncomitted changes')";
    push `HEAD:main` (fast-forward only; fetch and merge `origin/main` first if a peer pushed) and the branch.
- lessons:
  - target: project (this repo's `AGENTS.md`, the end of the "Rules (`src/rules/`)" list). Text:
    ```
    - Read AdvantageKit's GitDirty only through `isUncommitted()` (`src/match/git-dirty.ts`), never a regex of your
      own: older AdvantageKit writes "Uncomitted changes" (one m), and `/uncommitted/i` missed 10 of 520 library
      logs (2026-10-22).
    ```
    Evidence: this note, "What changed".
- focus: `done session:local_220c1820-1a73-431c-90a9-cc0f501eb152 --why "build/dirty spelling: fix landed on main as dde0e01 (2026-10-23), 10 new findings on 520 logs, 0 other golden differences"`
- verified: `origin/main` = dde0e01; `src/rules/build/dirty.ts` on it uses `isUncommitted`; the only
  `/uncommitted/i` left in `src` is `report/foresight-model.ts:66`, which tests Hindsight's own finding title (on
  purpose).

## What changed

- `build/dirty` matched GitDirty with `/uncommitted/i`. Older AdvantageKit versions write "Uncomitted changes", so
  logs from those versions never fired the rule. Seven other readers (auto/early-disable twice, session summary,
  report header, Foresight's snapshot code check, the match header, the pit-check record) had the same test.
- Now one `isUncommitted()` in `src/match/git-dirty.ts` (`/uncom+itted/i`) serves all of them.
  `tests/build-dirty.test.ts` covers both spellings with invented logs (event TEST).

## Proof

- Golden before and after the rule fix, 31 library folders (520 logs): `build/dirty` 314 → 324. The 10 new
  findings are all on logs whose GitDirty is "Uncomitted changes" (two days of 2024-09 matches); 0 other
  differences in findings, evidence, plots, not-checked reasons, crashes or parents.
- An independent byte search of the same files: "Uncomitted" in 10 (the same 10 files), "Uncommitted" in 314.
- Golden after the shared helper: 0 differences against the rule-only fix. early-disable fires on 5 of the 10
  one-m logs but they log no auto chooser, so it returns before the changed lines: no log on hand exercises that
  change; unit tests cover the helper and the report header line.
- Suites on the branch merged with main: vitest 1038 passed / 4 skipped, collector 48 OK, tsc and svelte-check
  clean. Landed with `--no-ff`; the merge's tree equals the tested branch tip.

## Not done

- Summaries saved in a browser before this keep their old `uncommitted: false` for those logs until reread
  (`SUMMARY_SHAPE` unchanged: same fields).
