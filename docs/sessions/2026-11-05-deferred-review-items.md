# 2026-11-05: three follow-ups from the plain-log profiles; four closed without building

Seven items were deferred from the review of the plain WPILib log work (2026-10-19). Each was measured on main first,
over 778 logs (758 team library, 20 public).

## Fixed

- **A profile with no known commit says "Code not known"**, not "Code as of unknown unknown" (`src/profiles/pin.ts`).
  `profileId` is left alone (a stored id), and so is `codeWords` in limit-not-applied (LN-11, fixed wording; no such
  profile has limits). A half-known pin (branch and no sha) still prints what it always did; no shipped profile has one.
- **`averagesOverTime`**: power/rest-voltage (a 2 s median) and power/main-breaker-margin (a 90 s heating average) carry
  no slow-logging note at 4 Hz or faster. Holding total current at a slower rate moved peak breaker load, in points of
  120 A: 17 Hz −0.33 to +0.42; 12 Hz −0.58 to +0.58; 4 Hz −2.08 to +3.75 (50 logs whose peak passes 60 A, 6 of them
  already slow, so the 4 Hz figure rests on 44). Under 4 Hz nothing is measured, so the note stays.
- **limit-not-applied needs two records over the line** (LN-04). One reading held across a logging gap read as a
  stretch: 1 of the 60 findings on these logs, and 45 of 69 slow stretches when a robot with 4 Hz followers was tried
  with limits read from its public code at its latest commit (an assumption, not the event's commit). Counting only
  first-to-last over-the-line record was rejected: it also cut real 50 Hz stretches (4 of 60).

## Closed without building

- **Slow leaders in follower-mismatch**: 3 of 423 logs with motors (one day, 18 to 26 Hz); compared only at fresh leader
  records they stay at 0 s off. None near 4 Hz.
- **Signal-level staleness**: one record can rightly stand for seconds. On these logs mech/stall has 2 one-record
  stretches of a held 0 rot/s (1.9 and 3.2 s). A rule of that kind must stay free to read them. The only other
  one-record case through `longerThan` is one tilt stretch (15.03°, 0.31 s), left as it is.
- **power/margin with a default brownout setting**: 28 of 526 logs have battery voltage and no setting. No default is
  knowable: logged settings are 6 V (474), 6.75 V (20), 5.75 V (3), 5 V (1), all one team's, and a roboRIO 1 is fixed
  at 6.3 V. 21 of those logs already report through power/brownout. The rule stays "not checked".
- **A rule for motor temperatures**: 2,227 motor-logs in 144 logs: median peak 27 °C, p99 57 °C, max 77 °C; 9 over
  60 °C, 0 over 80 °C; no incident tied to heat. Foresight's pit check already reads 60 °C. Waits for a real case.

Counts use logs enabled for more than 10 s.

## Proof

- Golden, 778 logs, base 95680df against the tip. Outside meta/not-checked, which follows, the only changes: rest-voltage
  note gone on 7 findings and partly-checked gone on 1; main-breaker note gone on 6 and partly-checked gone on 42; one
  limit-not-applied finding gone. None gained, 0 crashed.
- Tests on a clean copy: 1904 passed; with no team logs 1833 passed. `npm run check` 0 errors. `contract-check` met.
- Stryker, contract file alone: 204 killed, 1 timeout, 2 survived. One is the recorded equivalent. The other,
  `needsEnabled: false`, predates this branch (no contract test names the flag).
- Rendered: a public log's page reads "Code not known (best fit by signals)", and the rest-voltage line has left "Not checked".
  The Logging tab still marks that battery slot slow (true), now with "No check said so in this log".

## Reviews

Fable and `code-review high --max-findings all`, Fable blind, then Fable graded the list. Caught and fixed: none of the
`Changelog:` lines was a real trailer (a blank line above `Co-Authored-By`), so the release notes would have been empty;
the note dropped at rates nobody measured; the 2-record line labelled as measured. Three recorded as open items 4 to 6 in
the contract: one unchanged value held for seconds, a stretch clipped at enable, and the Limits tab's own burst definition.

A `Changelog:` line must sit directly above `Co-Authored-By`, with no blank line. Check with
`git log --format='%(trailers:key=Changelog,valueonly)'`.
