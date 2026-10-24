# 7. From the playoff cut-off, Hindsight analyses and flags change; it offers few fixes

Status: accepted, 2026-10-23

## Context

Playoff matches come close together (19 to 36 minutes apart at one 2026 event), and a change made in a short gap is a
risk of its own. Formula 1's parc fermé allows only a pre-agreed list of work after a cut-off.

## Decision

From a cut-off the student lead picks (default: alliance selection), the pre-match check flags any code change since
the last match and shows what changed. Hindsight offers fix patches only for red issues; anything else is offered
as "defer to the end of the event", and its fix stays one click away. Nothing is blocked. The emphasis is analysis: what
happened, and whether each open deferral still holds.

Amended 2026-10-24: "only for must-fix issues" became "only for red issues". ADR 4 no longer has a must-fix class (every
issue can be deferred), so the rule needed another test; Kevin ruled that a red is it. Red is the issue's priority as the
board shows it, or for a code finding as the code panel shows it.

As built (slice 16):

- The cut-off is a line in the event's history (an `event-note`, kind `cut-off`; its text is `alliance-selection`, a match
  such as `Q40`, or `off`; the latest line for the event wins). By default it has passed once the team has played its last
  scheduled qualification (the schedule's "before playoffs" gap); with no schedule, once an on-field playoff log exists.
  "After Q40" has passed once the team has played Q40. Any on-field playoff log passes it unless it is off.
- Once passed, the board and Foresight's queue checklist say: "Playoffs: analysis first. Code changed since the last match
  is flagged."
- The queue checklist adds an amber line, never a block and never a change to the word, when the robot's commit or its
  uncommitted-changes flag differs from the team's last on-field match log's; with the code folder (or GitHub) linked it
  lists the files that differ.
- A red issue's deferral points are as before. For any other issue the first suggestion is "the end of the event", the
  other points are still in the list, and a code finding's fix is folded behind one click.
- The board asks of each open deferral whether it still holds. A tick is a `checked` line whose value is `holds`, with the
  role and time, scoped to the event, fresh for 90 minutes like every tick, and only if made after the deferral.
