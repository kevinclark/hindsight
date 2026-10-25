# 11. Setup is asked where it pays off, never before a first result

Status: accepted, 2026-10-24

## Context

Team number, The Blue Alliance read key, GitHub source and Google sign-in sat together at the top of the Library.
Without the key the app silently said "no event name logged" and "before the next match" with no match named; the
fix lived on another screen.

## Decision

Each setting is asked at the point its absence costs something, with what it unlocks: the board's "before the next
match" offers the read key or a typed match number; the role is asked at the first edit. Now shows one "Set up this
laptop" card until it is done; the full form stays behind a "This laptop…" link. Nothing is greyed out or blocked
waiting for setup.

## Why

People start using a tool before reading its setup (NN/g, the paradox of the active user); an empty or degraded state
should say what is missing and offer the fix in place (NN/g, empty states). In a review of mocked alternatives on a
fixed first-run rubric, asking in place raised recovery from missing setup from 4 to 7 of 10, +0.45 overall on top of
the Now screen (ADR 10).

## Consequences

Whoever installs the tool finds the full settings form one click further away, behind "This laptop…". A typed next
match number is a new input the board's due points must honour without being taken for a schedule.

## As built (slice 2)

- The typed number is kept per event on this laptop (`src/board/typed-next.ts`, localStorage) and given to the
  timeline as its own input (`timeline(…, typedNext)` in `src/board/points.ts`), never as a one-match schedule: a
  one-match schedule would make it the event's last qualification, so "the end of the event" and "before playoffs"
  would name it and match deferrals would end once its log was in. With a typed number the timeline has a next match
  and nothing else (no last qualification, gaps or playoffs). It goes stale, and the field asks again, once a log of
  that match or a later one is in, or a playoff log is (`activeTyped`). The board, the queue sheet, Foresight's queue
  checklist and Now all name it. With a schedule it is ignored.
- `src/ui/NextMatchFields.svelte` (on the board and on Now) offers the number, or the read key with the team number when
  none is set; the key is never shown back. Once a number is typed the fields fold to one line.
- `src/ui/SetupCard.svelte` lists team number, read key, Google sign-in (only on a build with a Google client) and
  GitHub source, each with what it adds; it hides when every step that applies is done. The role is not on it: it is
  per person, asked at the first board edit.
- Not built: offering the code folder where a code check could not run for want of code. No check is listed "not
  checked" for that reason (Match review, the Session view and Foresight already offer the folder), and no log in hand
  exercised the one candidate.
