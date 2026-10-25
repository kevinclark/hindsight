# 10. Hindsight opens on a "Now" screen that says what to do at this moment

Status: accepted, 2026-10-24

## Context

The app opened on a row of seven peer tool tabs, the hub on its Library. On a new laptop the Library's first screen
was three settings fields, a robot address and a sign-in; nothing on it named the issue board or the pre-match check,
and reaching a first owned issue took 9 to 10 steps and 3 decisions. On a shared pit laptop, anything shown once per
laptop (a welcome, a setup checklist) reaches only whoever set it up.

## Decision

The app opens on **Now**: on an event day, the next match and the time left, then the tasks for this moment in order
(pull the last match's log, triage before the next match, the queue check), each one button; on a practice day, the
start-of-practice check, today's runs and what is still open; with no logs, the ways to get one and one line per job.
The tool tabs stay, behind it. A welcome and a setup checklist survive as Now's no-logs state and a setup card that
never blocks a first result.

## Why

Real tasks first (Carroll's minimalist instruction); overview before detail (ISA-101); show what comes next (Endsley's
projection level of situation awareness); help in context beats help out of context (Andersen et al., CHI 2012). In
a review of eight mocked alternatives on a fixed first-run rubric, Now scored 7.05 of 10 against 3.80 for the tool
tabs, 5.05 for a once-only welcome and 4.30 for a setup-first checklist. No study tests a screen that changes with
the situation: a student test checks it.

## Consequences

Someone who knows the tool reaches the Library in two clicks instead of one. Now's wording claims what to do next, so
it has to stay true to the board and the schedule; with no schedule it says the next match is not known yet.

## As built (slice 1)

- The model is `src/now/now.ts` (pure, tested in `tests/now.test.ts`); the screen is `src/ui/NowView.svelte`. The board
  is the Session view's own (`buildBoard`), the schedule is read as Foresight reads it (`src/tba/session-schedule.ts`),
  and the event-day signal from outside the Session view is one shared reader (`src/ui/today-signal.svelte.ts`) used by
  Now and Foresight.
- "Next match" names the first match that has **not started**. The board's next match is the one after the latest log, so
  until the last match's log is pulled it can be a match already played; Now skips the qualifications whose start has
  passed. The pull task reads "Pull Q33's log" until that log is the session's latest, then "Q33's log is in".
- The Session view does not watch the library: it reads the logs it is given. Now therefore hands it today's library
  logs (the same ones, by the Library's own path) when "Open the board" is pressed, after a pull or a folder is added
  from Now, and when the number of today's logs in the library grows while the Session view holds a session.
- A pull tries USB first, then the Ethernet and by-name addresses the team number gives, moving on only when the robot
  did not answer. Now never probes the robot before the button is pressed, and never says it is connected.
- On the single-file page the hub-only tasks become "open a log" (a file chooser; a log dropped on Now also opens in
  Match review).
- Not in this slice: the tagline, the setup card and typed match number, other tabs' empty states.
