# 14. Rules on .hoot data are experimental, and every match says what would check more

Status: accepted, 2026-11-09. Supersedes ADR 13 decision 6 ("no rule, finding, phone card or event line reads it").

## Context

ADR 13 made the .hoot a view (the Devices tab). A backtest then ran Hindsight's rules on 13 practice runs of one robot
(2026, 2,598 s enabled) with the inputs the robot profile maps taken from the .hoot instead of the robot log: the inputs
agree (currents, velocity, temperature, gyro: same scale and peaks), but few rules had cases to compare. A .hoot also
holds what no robot log we have records: each CTRE device's own health faults.

Most of what Hindsight can't check is for want of data the team could add: a Driver Station log, a signal the robot
code doesn't log, a key the robot profile lacks. Each match listed these as raw reasons, one rule at a time.

## Decision

1. **Every match says what would check more.** Each not-checked reason is placed by what would let its rule run
   (`src/coverage/unlock.ts`): a file beside the robot log (.dslog, .dsevents, .hoot), a signal the robot code logs
   (or logs faster), the robot profile, the Hindsight companion; or nothing (the match didn't happen that way), or
   "another reason" when the text is not one we know. Match review groups its Not checked list this way, per match;
   the Session view adds the same grouping across the session, counting partly checked rules too. The grouping is read
   from the reason text, so it works on every summary an older Hindsight saved. The .hoot group shows per match only:
   session summaries hold no experimental rule, so the Session view never lists it. Revisit when .hoot logging is back on.
2. **Rules on .hoot data are experimental** (Kevin, 2026-11-09: "apply the rules speculatively and indicate they're as
   such in the ui"; "Let's not automate verification yet. Let's mark them as experimental and we can confirm later").
   An experimental rule sets `experimental` and is not in `RULES`: it runs on its own list (`EXPERIMENTAL_RULES`) into
   `Report.experimental` and `Report.experimentalSkipped`, never `findings` or `skipped`. So nothing counts it, no
   consolidator links it, nothing puts it on the board, in findings.json, on the phone or in a session summary. Match
   review draws it in its own section below every other finding: no severity colour or icon, the word "experimental",
   a dashed border, why it is experimental. A match whose only findings are experimental never reads as clean.
3. **No automated verification.** No tally, scorecard or comparison in the app. A rule leaves the tier only by a later
   decision of a person, made from a backtest and committed with a note.
4. **One robot run is one match.** A .hoot lined up with its robot log by enable edges (`src/hoot/attach.ts`, the same
   `alignTo` the Devices tab uses) is attached to that match; rules run once; each signal comes from the best source
   the match holds and the finding names it (`read from`); never two findings for one event seen in two files.
5. **Opening a match never runs owlet.** Readings already in the cache are attached when a library log opens; a .hoot
   not read yet is read by the Devices tab, which hands its readings up. Each analysis pass builds new Matches, so the
   app attaches them again after every pass. Session summaries never read a .hoot: nothing about a .hoot joins a
   summary's key or the phone's analyzer id.

## Evidence per rule (2026-11-09; the confirmation, when it comes, starts here)

| rule on .hoot data | evidence | status |
|---|---|---|
| can/device-fault (health fault while enabled) | 1 case in 22 CANivore files (a Talon FX bridge brownout, 0.26 s); no robot log has per-motor faults, so nothing to confirm it against | built, experimental |
| device restart (ResetCount up) | 0 in 22 files | not built: no data covers this |
| mech/stall | 3 of 3 agree (backtest) | not built: the robot log had the input every time |
| power/limit-not-applied | 3 of 3 agree at the .hoot's rate; one .hoot-only error at the robot log's rate | not built: as above |
| collision/tilt | 14 of 14 agree, every case the robot on its side | not built: as above; no hoot-only file has a Pigeon |
| power/rest-voltage | 4 of 8 disagree: the Talons' median reads 0.06–0.09 V above the roboRIO | not built: biased |
| brownout, collapse, breakers, margin, wiring resistance, follower mismatch | no case on either side (lowest battery 7.96 V) | not built: no data covers this |

A .hoot filling a signal its robot log lacks has 7 logs × 3 rules in our library (one motor after it was taken out of
the code, peak 0–8.3 A against a 40 A limit: no finding possible) and needs per-device series the cached reading
doesn't keep. Not built. Rules on a hoot-only log: one file of 9 s, no fault, no profile: not built.

## Consequences

A team with .hoot logging off sees "A .hoot (experimental, not counted)" in every match's Not checked list, which is the advice to turn it on. The Devices tab is still the way to read a .hoot the first time. How students
read "experimental" is untested.
