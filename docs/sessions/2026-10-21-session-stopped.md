# 2026-10-21: the Session view says when a finding stopped firing

Branch `claude/session-stopped-016ad5`. Not merged: waiting for the maintainer's go.

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
