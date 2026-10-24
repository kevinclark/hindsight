# 6. The event schedule comes from The Blue Alliance, anchored to match numbers

Status: accepted, 2026-10-23

## Context

Suggesting a deferral point ("the lunch gap", "before eliminations") needs the event schedule. The Blue Alliance
publishes it before matches start; the number and order of a team's matches don't change, but the times drift during
the day. The pit laptop is often offline.

## Decision

Hindsight reads the schedule from The Blue Alliance with the team's own read key, keeps a copy for offline use, and
names every deferral point by match number ("after Q37: overnight"). Times are shown as estimates. Without a schedule
it asks for the next match number.
