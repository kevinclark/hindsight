# 3. Modes are inferred from the log and always shown

Status: accepted, 2026-10-23

## Context

What Hindsight judges and how it ranks depends on the situation: an event (practice matches, quals, elims), practice
away from a field, or investigating one problem. The mode could be picked by the user or inferred from the log's FMS
data (attached or not, match type). In one team's library of 758 logs, every non-stub log carried those facts: 76 were
on a field and 627 were not.

## Decision

Hindsight infers event or practice mode from each log's FMS data, shows the mode beside every verdict, announces a
change, and lets the user change it in one click. Debug is not a mode: it is a workspace opened from a finding or a
symptom.

The mode is decided per local day: a day with any on-field log is an event day, and a pit run on it is judged by run
(ADR 8) and belongs to the event. (Added 2026-10-23 after review: deciding per log would turn a tethered pit run
between matches into practice and split the event day in two.)

## Why

Inference removes a setup step. Modes that change on their own are a known cause of mode confusion (Sarter & Woods,
"How in the world did we ever get into that mode?", Human Factors, 1995), so the mode is never hidden.
