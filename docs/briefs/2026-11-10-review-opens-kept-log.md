# Brief: the phone's Match review opens a log kept on the phone (2026-11-10)

## Problem (Kevin, on his iPhone)

Phone → Match review → pick a match whose log he had already opened from the Library: he sees the laptop's published
`MatchSummary` (`SummaryReview`), which has no Power / Limits / Logging tabs. Library → "Open · on this phone" on the
same log runs the full analysis on the phone (`openFromPhone` in `src/App.svelte`) and shows every tab. Match review
never looks at the logs kept on the phone (`BrowserHub.keptLogs()`, `src/hub/browser-hub.ts`).

Kevin's decision: the phone does the analysis itself when it has the log.

## What to build

Worktree `/Users/kev/code/makers/hindsight-wt-reviewopen`, branch `claude/review-open-on-phone`. Phone only (`readOnly`
in `src/App.svelte`); the laptop is unchanged.

1. **Find a summary's log.** Pure helper in `src/ui/phone-library.ts`: `entryForSummary(entries, { fileName, fileSize })`
   → the `Entry` whose `names` include `fileName` and whose `record.size === fileSize`; `null` when none or more than
   one match. Unit tests in `tests/phone-library.test.ts` (match, wrong size, two candidates → null, none).
2. **Match review knows the Library.** When the phone enters Match review, read `phoneHub.logs()` and
   `phoneHub.keptLogs()` once (refresh kept after any open). A failed read leaves Match review as today (summary only),
   with no error drawn.
3. **Kept → open the full review automatically.** When the shown summary (the picked one, or the default latest) has an
   entry that `onThisPhone([entry], kept)` says is kept, open it: `phoneHub.openLog(entry)` then the same analysis
   `openFromPhone` runs. Not again for a match the person sent back to the summary (step 6) until they pick it again.
4. **Not kept → a button.** Under the summary's head: `Full review · N MB` (size = log + its DS logs, the Library's
   `sizeOf`). Pressing it downloads through `openLog` with the same progress line, `<progress>` and Stop as
   `PhoneLibrary.svelte` (extract that piece into one shared component or function rather than copying it). A failure
   shows in words with the match name; Stop returns to the summary.
5. **The match picker stays.** Today the `nav.pick` match list draws only when nothing is open (`readOnly && !current`).
   A log opened from Match review keeps the picker above the full review, its match marked current; picking another
   match goes to its summary (and step 3 opens it if kept). A log opened from the Library keeps today's line ("Opened
   from the Library · Back to the Library") and no picker. Track where the open came from (`'library' | 'review'`).
6. **What the phone's read lacks.** Over a full review opened from Match review, one line: `Read on this phone.` plus,
   when they differ, which rules the laptop's summary has more findings for than this read (compare per rule id the
   count of findings in `summary.rules[id].findings` with the analysis's findings for that rule), e.g. `The laptop's
   read found 2 more (limits/not-applied, code/x): it had the robot code folder` — say "it had the robot code folder"
   only when `summary.codeFolder` is set and the phone has none. Then a `Laptop's summary` link that shows the summary
   (step 3 then does not reopen it). Pure function for the comparison, with tests.
7. **One log in memory at a time**, as today: picking another match lets the open one go (`clearAll`).
8. **Dev fixture you can see.** `src/phone-fixture.ts` (dev only) gets one log so the path can be driven in a browser:
   build a wpilog from `fixtures/brownout.json` with `writeWpilog` (`tests/helpers/fixture-format.ts`; move the writer
   to `src/` only if a dev import from `tests/` fails to build), add a manifest line for it under `manifests/` and a
   matching match summary to the fixture event (same file name and size), and give `installPhoneOver` a `media` object
   whose `downloadWhole` returns those bytes. Check `docs/privacy.md` / `docs/iphone.md` and update the one line in
   `docs/iphone.md` that describes Match review.

## Checks (all must pass in the worktree)

- `npx vitest run` (the whole suite) and `npm run check` (svelte-check): no new errors.
- `npm run build` and `npm run build:phone` succeed.
- New tests: `entryForSummary`, the per-rule comparison, and a server render (`svelte/server`, as in
  `tests/phone-read-only.test.ts`) showing the `Full review · … MB` button for a summary whose log is not kept.
- Commit on the branch with a pathspec, message saying what changed and why; do not push, do not merge to main.

## Out of scope

The laptop. Hoot files on the phone. Changing what the laptop publishes.

## Report back

Files changed, test counts before/after, anything in the spec you could not do as written and what you did instead.
