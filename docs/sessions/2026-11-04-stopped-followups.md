# 2026-11-04: stopped-firing follow-ups

The five follow-ups from `2026-10-21-session-stopped.md`, on branch `claude/stopped-followups` (base 22f7525).

## What was built

1. `needsEnabled` (src/rules/rule.ts, run.ts): a rule that judges only enabled time says "not checked: the robot was
   never enabled" on a match log with no enable, instead of counting as quiet in "Not seen since". A Foresight view
   (it has a pit stretch) is never skipped. Set on collision/tilt, mech/stuck-state, mech/slip, mech/zero-not-completed,
   power/limit-not-applied, can/bus-dropout, can/device-dropout, auto/none-at-enable. `SUMMARY_SHAPE` 4.
2. auto/none-at-enable judges the first auto that started with the FMS attached, not the log's first enable.
3. comms/ds-log-truncated checks "no match in this log" before "no .dslog loaded"; tested through `analyzeFiles`.
4. A fixed mark's quiet count looks for the item's own not-checked reason by the item's name (`Finding.item`, set
   only when it differs from `about`): limit-not-applied's key says "Drive supply", its reasons start "Drive:".
5. The printed Session report has a "Stopped firing: potentially fixed (N)" sub-heading before the sunk rows.

## Evidence

- Measured on 758 library logs before building: 195 never enabled (the 10-21 note said 55 of 264; about 140 of the
  195 can enter a session, the rest are stubs the app never puts in one). The 10-21 list was wrong in two ways:
  power/brownout judges the whole log and fired on 3 never-enabled logs, so it is not flagged; the two CAN dropout
  rules and zero-not-completed also read quiet there, so they are.
- Item 2: 4 of 74 on-field logs had an enable before the field auto; none would fire.
- Golden, 758 logs, 22f7525 vs the branch tip: every finding identical except `item` on 60 limit-not-applied
  findings. Skip lists: 1,289 new "never enabled" entries (replacing older reasons on 179 logs), none-at-enable's
  reworded reason, ds-log-truncated's "no match in this log" on 195 logs, and 3 logs with an earlier enable now read
  "missing auto choice" (no chooser key in those logs; still not checked). One log is now judged by none-at-enable
  (quiet).
- Suite 1851 passed, 4 skipped; `npm run check` 0 errors; contract-check all met.

## Reviews (Fable + code-review high)

Folded: item taken from the first finding that has one (a pre-change summary can come first); the ds-log-truncated
guard order; none-at-enable uses the flag instead of its own guard; a runner-level test that `item` is set; doc
wording; `break-after: avoid` on the heading; CONTRIBUTING and AGENTS notes. Not folded: reusing `autoStart` in
none-at-enable (it still needs both checks: no simpler), and a test forcing every enabled-only rule to declare the
flag (every unflagged rule already covers itself; judgment, no case).

## Caveats

- Saved summaries are only cued "Read again to update" by the shape bump: until re-read, old summaries still count
  never-enabled logs as quiet and lack `item`.
- The heading's render covered only a sunk-only session (synthetic logs no profile fits), not a live row above it.
- The JSON export now carries `item` (it spreads the finding).
