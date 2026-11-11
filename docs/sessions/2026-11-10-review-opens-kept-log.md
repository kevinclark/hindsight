# 2026-11-10 — the phone's Match review reads the whole log itself

## Handoff

- leftovers: none
- repos:
  - /Users/kev/code/makers/hindsight → stage `docs/sessions/2026-11-10-review-opens-kept-log.md` and `AGENTS.md`; message: "Session note: the phone's Match review opens the log it holds (66c623b); the dev phone fixture has one log to drive"
- lessons:
  - target: project (this repo's AGENTS.md, in the section on the phone / iPhone app if one exists, else at the end of the file). Text:
    `- The dev phone fixture (\`?phone-fixture\`, src/phone-fixture.ts) holds one log: Q1, a wpilog built from fixtures/brownout.json at load, with a manifest line and a \`media\` that serves it (~1.2 s fake download). Drive the phone's open paths (Library, Match review's Full review, kept-log auto-open, Stop) there in a browser at phone size. Its heading reads "Qualification 3" and "unnamed robot": that is the fixture's log, not a bug.`
    Evidence: this note, commit 0d9a7b8.
- focus: `done session:local_20ea109c-bd76-4a1c-9fb5-0ec95340b5e3 --why "Phone Match review full review: shipped to main 66c623b (2026-11-10), in the TestFlight build ddbe3de uploaded 2026-11-11 06:33 UTC; Kevin checked it: 'Looks great'"`
- verified: re-pulled 2026-11-11: 66c623b is an ancestor of origin/main (ddbe3de); branch claude/review-open-on-phone on origin at 66c623b; the `ios` workflow on main at ddbe3de concluded success at 06:33 UTC with its "Sign, then upload (main)" step successful; worktree hindsight-wt-reviewopen clean but for its node_modules symlink.

## What happened

Kevin saw different results on the phone: Match review → a match he had already opened showed the laptop's published
summary (no Power/Limits/Logging tabs); Library → "Open · on this phone" showed the full review. Cause: Match review
only drew the `MatchSummary` and never looked at the logs kept on the phone.

Decision (Kevin): the phone analyses the log itself when it has it. Built from the brief
`docs/briefs/2026-11-10-review-opens-kept-log.md` by a Sonnet implementer (0d9a7b8), then reviewed by Fable and a blind
code-review (high, 14 findings, graded by Fable); fixes A–L in 66c623b. Tests 2852 → 2867, svelte-check clean, both
builds pass; driven in the browser at 375×812 on the dev fixture.

## Behaviour now (phone only)

- A match whose log is kept on the phone opens the full review automatically (re-reads the keep first; never downloads;
  never above 275 MB).
- Otherwise `Full review · N MB` downloads it with progress and Stop; kept logs show `Full review · on this phone`.
- The match picker stays above the full review; a line says "Read on this phone." and which rules the laptop's read
  found more for ("It had the robot code folder; this phone has none." only when the summary names one), with a link
  back to the laptop's summary.
- One open at a time across Library and Match review.

## Not covered / known gaps

- A match recorded in several logs (robot restarted mid-match) gets the summary only.
- Race handling (A–C) is covered by the browser drive, not unit tests; a Library open in flight against Match review
  and a failed open were not driven in the browser.
- Deferred by review: moving the phone-review state out of App.svelte into a module with explicit states; one shared
  Library listing for App and PhoneLibrary.
