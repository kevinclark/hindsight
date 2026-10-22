# 2026-10-21: the Session view says when a finding stopped firing

## Handoff

- leftovers:
  - `focus add "Hindsight: should power/limit-not-applied say not checked when current never neared the limit?" --project hindsight --next "Kevin's pick: a faithful 'exercised' test (current reached the limit) makes most motor groups not checked in most matches; leaving it quiet lets an unused group count as clean for 'not seen since'. See docs/sessions/2026-10-21-session-stopped.md, Judgment calls 4." --session local_1318f05c-01f5-4ae9-bc63-f3ca46179f8f` (only Kevin can pick)
  - `focus add "Hindsight stopped-firing follow-ups" --project hindsight --next "1) needsEnabled flag the runner honours like foresightOnly, for brownout, battery-collapse, tilt, impact, stuck-state, state-exits, slip, limit-not-applied, tracer-steps (never-enabled logs read quiet; 55 of 264 local logs); 2) auto/none-at-enable: judge the first on-field auto, not the first enable; 3) test comms/ds-log-truncated's not-checked path; 4) pass about into the fixed-mark count; 5) PDF 'Stopped firing' heading. Golden before/after each; see docs/sessions/2026-10-21-session-stopped.md" --session local_1318f05c-01f5-4ae9-bc63-f3ca46179f8f`
- repos:
  - hindsight (`~/code/makers/hindsight`): already committed and on origin/main (merge 0b764c3); this note's Handoff block is committed and pushed by the seat. Nothing for the delegate to stage.
- lessons:
  - target: `project` (hindsight `AGENTS.md`, section "## Rules (`src/rules/`)", a new bullet after the golden bullets). Text:
    "- A session counts a quiet match as clean (\"not seen since\", src/session/stopped.ts), so a `check` whose early
      return means \"this didn't happen in the match\" (never enabled, not on the field, never moved) calls
      `match.couldNotCheck`, never a bare `return`. A rule for only some motors or groups declares `only`: an item
      that returns nothing counts as checked (2026-10-21: 12 rules changed, 264-log golden 0 residual)."
    Evidence: this note, "What was built" and "Evidence".
  - target: `skill work-routing § Fable review` (the section on folding a reviewer's findings). Text:
    "Re-run the real data on a reviewer's suggested *fix*, not only its finding: a fix described as having \"no effect
     on the real cases\" can still change them (2026-10-21: a suggested guard keyed on a variable that stays null when
     the zero lands before the first enable would have turned 3 of 7 real matches to not checked; the event re-run
     caught it)."
    Evidence: this note, Judgment calls; hindsight commit f0da822 message.
- focus: `done session:local_1318f05c-01f5-4ae9-bc63-f3ca46179f8f --why "Hindsight stopped-firing labels: PR #1 built, Fable + code-review folded, merged on Kevin's go 2026-10-21 (0b764c3, 22:43 PDT); hindsight.html rebuilt 22:45 and contains the new text"`
- verified: 2026-10-21 ~22:50 PDT re-pulled: origin/main = 0b764c3; GitHub PR #1 closed, merged=true, merge_commit 0b764c3; `~/code/makers/hindsight` on main at 0b764c3, clean; its hindsight.html contains "Stopped firing: potentially fixed"; this worktree clean; no open focus item matched "hindsight stopped".

Branch `claude/session-stopped-016ad5`, PR #1, merged 2026-10-21 as 0b764c3.

## What was built

- `src/session/stopped.ts`: a student's fixed mark leads ("Marked fixed after Q21 · quiet in 3 checked matches
  since", counted per issue, only after the mark). With no mark, "Not seen since <match>" when the rule's grid row has
  2 or more checked matches after its last firing, all quiet, with the exact chance C(n, k) / C(N, k) of a run that
  clean with no fix (BigInt, compared as fractions). "Potentially fixed" at 0.05 or less; only then does a warning sort
  below the live findings and join the bottom line's "Stopped:" group. An error never sinks. "Code changed in
  between" from each log's own build sha. The same text in the view, the report/PDF, the card and the JSON.
- Item 4, quiet means exercised: 12 rules whose early return meant "not exercised" now call `couldNotCheck`. A rule
  can declare `only` (motor, motorGroup) for the things it is for; without it, follower-mismatch and stall stayed
  "partly checked" (counted as quiet) when their only applicable group or motor wasn't exercised.
- `SUMMARY_SHAPE` 3: saved summaries counted those matches as quiet.

## Evidence

- Golden on 264 local logs, before and after: 0 residual differences once the changed rules' "not checked" entries
  and meta/not-checked are stripped. Largest additions: off-field logs (234: early-disable, restart-mid-match),
  never-enabled logs (55), a follower group whose leader never held a steady speed (85 + 78 for an elevator, which
  never reaches the 20 rot/s steady line), and mechanisms that never moved (36 + 32).
- On the 7-match test event, every fired rule's cells are unchanged (only mech/stall, which never fired, went from
  quiet to not checked). Expected false "potentially fixed" labels at 0.05 with these firing counts: 5/21 = 0.238.
- mech/stall's "turned" line, 0.05 rot/s, is assumed: of 45 logs whose turret never passed the 0.2 rot/s stall line,
  31 read exactly 0 and 14 peaked at 0.012–0.178 rot/s.

## Judgment calls (reviewed)

1. "Not seen since" uses the rule's grid row; a row whose own issue last fired earlier says "(this one last in Q2)".
   Per issue key would add about 20 labels on one test event and multiply the false-label rate.
2. The fixed-mark count is per issue key.
3. A potentially fixed error keeps its place and its confidence clause; the label still shows.
4. `power/limit-not-applied` unchanged: "never over 120 % of the limit" is also true when current never neared the
   limit. A faithful test would make most groups "not checked" in most matches. Open question.

## Follow-ups

- Never-enabled logs still read quiet for rules that judge only enabled time (brownout, battery-collapse, tilt,
  impact, stuck-state, state-exits, slip, limit-not-applied, tracer-steps). They land in practice sessions, not
  events. Proposed hook: a `needsEnabled` flag the runner honours like `foresightOnly`.
- `auto/none-at-enable` judges only the log's first enable: judge the first on-field auto instead.
- `comms/ds-log-truncated`'s new not-checked path (practice log plus .dslog) has no test.
- Pass `about` into the fixed-mark count instead of parsing it from the issue key.
- The PDF has no "Stopped firing" heading; the bold "Potentially fixed" line and the bottom line carry it.
