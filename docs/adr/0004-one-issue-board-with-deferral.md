# 4. One issue board across matches, with deferral to a named point

Status: accepted, 2026-10-23

## Context

Hindsight already lets a finding be marked known, fixed, real or not a real problem, but a problem seen in five
matches shows as five findings, and nothing says how urgent it is or when it will be fixed. At an event a team can't
fix everything at once.

## Decision

- One board lists issues across matches, grouped by mechanism.
- Each issue has a priority (three levels, with a cap on reds per match: every red must call for an action, as in
  ISA-18.2 alarm management) and a status: Open, Fixing, Check next match, Closed.
- An issue closes only after a clean match that follows the fix.
- An issue can instead be deferred to a named point:
  - the next match;
  - the next gap in the schedule of at least a given number of matches or minutes;
  - before eliminations;
  - the end of the event;
  - the next event.

  A deferral carries a workaround line for the drive team. When Hindsight has the event schedule, it suggests the
  point.
- Every issue can be deferred (amended 2026-10-24: no must-fix class for now; one may be added once real events show
  which problems a team must never carry). The pre-match check reads all open deferrals together.
- The owner is a role (software, pit, drive). The board records who changed what.

## Why

This is modelled on the aviation Minimum Equipment List: a known fault flies under a repair deadline (categories B, C
and D: 3, 10 and 120 days), an operations procedure, and conditions. The deadline here is counted in matches and
schedule points, not days. The closing rule is the closed loop of a failure reporting and corrective action system
(FRACAS).
