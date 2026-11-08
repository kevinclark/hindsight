# 12. Queue and start times come from Nexus where the event queues with it

Status: accepted, 2026-11-07

## Context

ADR 6 read the schedule from The Blue Alliance only. At an event, the time that matters to the pit is when the team is
called to queue, and The Blue Alliance does not have it: its predicted start can be minutes off while queuing runs
early or late. Many events queue with Nexus (frc.nexus), which publishes live estimated queue, on-deck, on-field and
start times for every match through an API with a per-person key.

## Decision

A laptop may hold a Nexus API key (optional, each person's own: frc.nexus/api, signed in with Google). With one, the
schedule read from The Blue Alliance also carries Nexus's queue and start times, joined by match number
("Qualification N" is qmN, "Playoff N" is sfNm1, "Final N" is f1mN; practice and replays are not joined). Now's big line
says when to queue and when the match starts, or Nexus's call ("queuing now", "on deck", "on the field") once it is
made, with a link back to Nexus. Every other estimate (the board's time left, the queue sheet, the gaps) takes Nexus's
start before The Blue Alliance's prediction. Match numbers still name every deferral point (ADR 6). Whether a match has
started comes from The Blue Alliance's actual time; only before any match of the team's has one (the first match of an
event, or an old saved copy) does Hindsight count a match started once its expected start has passed, and that start is
now Nexus's estimate, so it can move by a minute as Nexus re-estimates.

## Why

Kevin, 2026-11-07, at an event that queued with Nexus: "Let's show queue and start time and let people put in their
own nexus keys." For that match, Nexus's team page gave the time to queue (4:21 PM) and The Blue Alliance only a predicted
start (4:44 PM): The Blue Alliance has no queue time at all. How Nexus's start estimate compares with The Blue
Alliance's prediction has not been measured.

## Consequences

A Nexus copy is good for 50 seconds and Now reads again every minute while a key is set. Without a key, at an event that
does not use Nexus, or when Nexus cannot be reached and has no saved copy, everything reads as before and the schedule
note says why. The playoff mapping rests on Nexus's documented examples, not yet on a real event's playoffs.
