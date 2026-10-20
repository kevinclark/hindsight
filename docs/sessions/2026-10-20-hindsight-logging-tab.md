# 2026-10-20: Logging tab, wanted checks and auto/none-at-enable

## Handoff

- leftovers:
  - `focus add "Hindsight auto/none-at-enable: gate on the field auto, bound 'picked later' to the end of auto" --project makers --next "Backtest first (today it fires on MTTD 2025 p5 only); brief in docs/sessions/2026-10-20-hindsight-logging-tab.md, Follow-ups 1-2; or start proposed card task_ef481c13" --session local_7ca997d4-cecb-4f29-ae66-64b6100d0853`
  - `focus add "Hindsight Logging tab: 4 review follow-ups (structured skip keys, short-enable rate, mixed-profile sessions, session-load cost)" --project makers --next "docs/sessions/2026-10-20-hindsight-logging-tab.md, Follow-ups 3-6; none changes today's logs" --session local_7ca997d4-cecb-4f29-ae66-64b6100d0853`
  - The two FTA label bugs (comms/loss.ts CPU label, loop/overrun.ts:21) are already focus item ea88: no new item.
- repos:
  - /Users/kev/code/makers/hindsight (worktree .claude/worktrees/logging-tab-cf4e65, branch claude/logging-tab-cf4e65,
    fast-forwarded to origin/main): stage `docs/sessions/2026-10-20-hindsight-logging-tab.md` and `AGENTS.md`; message
    "Session note: Logging tab build (merged b28cacf); AGENTS.md: plain-node modules must not import src/version.ts";
    push with `git push origin HEAD:main` (fast-forward only) and `git push origin HEAD` for the branch.
- lessons:
  - target: project (this repo's AGENTS.md, a new section "## Plain-node scripts" after the Rules section)
    text: "`src/version.ts` imports `package.json`, which plain node (`--experimental-strip-types`: golden, check,
    scripts) can't load without a JSON import attribute. Code those scripts reach (rules, coverage, session) must not
    import it, even through `src/report/review-model.ts`; shared report helpers go in their own file
    (`src/report/repo-paths.ts`)."
    evidence: commit 4a39f58 (coverage importing stripRepoPaths from review-model broke a node script; vitest and vite didn't notice).
- focus: `done session:local_7ca997d4-cecb-4f29-ae66-64b6100d0853 --why "Hindsight Logging tab + auto-None rule build: built, Fable + code-review folded, merged to main as b28cacf by the parent session (Kevin approved 2026-10-20); follow-ups queued as two focus items, FTA bugs already ea88"`
- verified: origin/main (1fdf3dd at sync) contains 4a39f58 (merge b28cacf); on main, SessionView has "Logging across
  the session" and RULES has noneAtEnable. Not re-run after the merge: the golden comparison (main has 47 other
  commits that change findings, so the before/after files no longer compare).

## What was built (branch claude/logging-tab-cf4e65: 3db1ced, e38d5c3, 4a39f58)

- `src/coverage/coverage.ts`: `coverageKeys(profile)` starts from `profileKeys` and adds battery lists, camera stale
  and result, other devices, zeroing, state machine, CAN bus members, alert groups, and the e-stop, match clock and
  chooser keys. Each line is logged, slow, never changes, not logged, or no key in the profile, with the checks that
  went dark (parsed from `report.skipped`) and what they catch.
- Logging tab per match (`src/ui/LoggingTab.svelte`); "Logging across the session" in the Session view
  (`MatchSummary.logging`).
- `src/rules/wanted.ts`: `WANTED_CHECKS` (CTRE status at boot, hood zeroed since boot, camera serial, log USB stick
  as live-only).
- `auto/none-at-enable` (amber, RULES only).

## Measurements

- Slow bar for power keys (battery voltage, motor supply current): 729 keys on the logs the profile fits, of 141
  local logs: 666 at 49.5 Hz or more, 22 at 45–49.5 Hz, 41 below 45 Hz. "Slow" is under 45 Hz (judgment: 90 % of 50
  for one loop of jitter). Other measured keys use the rules' own 30 Hz line exactly.
- First enable across 141 logs: 35 never enabled; 85 off the field (74 read "None", 2 no chooser key, 9 set);
  20 with the FMS attached: 2 teleop (q28 restart pieces), 17 auto with the chooser set, 1 auto with no chooser key
  (p2), 1 auto on "None" (p5).
- Backtest: the rule fires on `akit_25-11-07_19-38-15_p5` only. Labelled a true positive: the chooser was logged once
  as "None" (14.7 s), the FMS attached at 27.1 s, auto ran 15 s, and odometry travelled 6.8 mm in auto against 5.4 m
  in teleop's first 5 s. A practice match, so a deliberate "None" can't be ruled out.
- Golden before/after over the 141 logs: three groups byte-identical; MTTD differs only by p5's finding and p2's
  `meta/not-checked` gaining the new rule's not-checked line (title 5 → 6 rules). Accepted after review.

## Follow-ups (graded by a Fable reviewer)

1. Gate the rule on the field auto (`match.ts` `fieldAuto`) instead of the log's first enable. Q41 is the only local
   log with the FMS attached whose first enable was off the field; its chooser was set, so nothing changes today.
2. Bound "auto chooser picked later" to the end of the first auto (a later pick may be the next match's).
3. Record `{rule, key}` on `SkippedRule` instead of parsing reason text (the proposal's step 2; changes golden's
   serialised `skipped`).
4. Say "rate not judged (short enable)" when `sampleRate` has under 20 gaps.
5. `loggingChanges` across a session read with two profiles joins runs across matches that lack a key.
6. Measure the session-load cost of decoding stator and velocity keys in `summarizeMatch`.
