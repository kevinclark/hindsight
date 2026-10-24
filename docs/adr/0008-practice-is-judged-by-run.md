# 8. Practice is judged by run, not by match

Status: accepted, 2026-10-23

## Context

Off the field, robots are enabled in stretches of any length. In one team's library, practice logs ran a median 3.5
minutes (10th to 90th percentile 0.9 to 15 minutes), the enabled span 10 to 211 seconds (median 61), and 91 of 578 were
never enabled; on the field the enabled span was 131 to 163 seconds in nearly every match.

## Decision

In practice mode the unit is a run (one enabled stretch) and a practice day is a session. Rules about match timing are
off; trends per mechanism and per battery come first; a run under about 10 seconds is checked for faults only. The
library shows practice logs by session and keeps logs that were never enabled, or are too short to judge, out of
trends.
