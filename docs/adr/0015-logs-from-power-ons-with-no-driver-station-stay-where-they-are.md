# 15. Logs from power-ons that were never enabled are not pulled or uploaded unless asked

Status: accepted, 2026-11-11 (the owner's decision).

## Context

A roboRIO writes a log at every power-on, and most of those boots are never driven: the robot is switched on in the pit,
looked at and switched off. Pulling them off the robot and putting them on the team Drive costs real time on a weak
connection and fills the library with files that hold nothing a rule can judge.

AdvantageKit names a log `akit_<random hex>.wpilog` and renames it to a timestamp only once `DriverStation/DSAttached` and
`SystemStats/EpochTimeValid` have held for 5 seconds (`WPILOGWriter.java`, AdvantageKit main). A robot can't be enabled
without a Driver Station, so a log still carrying the hex name was never enabled.

That rule has a window. An off-field log that ends within about 17 s of the Driver Station attaching keeps its hex name,
and could have been enabled in that time: at one event the robot's clock became valid 9-12 s after the attach in 3 of 35
logs. No such log has been seen (every hex-named log read so far never enabled), but nothing rules it out, and it is the
one way a pull can leave behind a log that was driven. Also: 8033's logs carry `SystemStats/SystemTimeValid`, while
AdvantageKit main's key is `EpochTimeValid`; the 5-second rule above is read from main's source, not from our logs.

Measured on one team's library with Hindsight's own reader:

- 23 of 23 hex-named logs never enabled; 4 of 36 timestamp-named logs never enabled either (a Driver Station attached,
  nobody pressed Enable).
- At one 2026 event the never-enabled logs were about 750 MB of about 1.7 GB, about 620 MB of it hex-named.
- Hindsight's rules on 18 never-enabled event logs: no warning or error, only info (start-up camera alerts). One boot lost
  four swerve turn motors one by one 10 minutes in; the owner judged that not compelling enough to carry the cost.

Hindsight never deletes from the robot, so a skipped file stays on the robot's USB stick.

## Decision

1. **A robot pull leaves hex-named logs on the robot.** A file named `akit_` and 16 lowercase hex digits and `.wpilog`
   (`noDriverStationName`, `src/hub/robot.ts`) is not offered to ingest. Other kinds of file, and logs with a timestamp name,
   are pulled as before. A file still being written is reported as that, not as skipped. A hex-named file whose path, size
   and modified time are already in the pull's memory (`seen.json`: it was pulled once with the force option) is in the library
   already and is not counted. A skipped file is never marked seen, so a later forced pull still gets it.
2. **A sync keeps never-enabled logs on this laptop.** A log whose record has `runs.count` 0 (`neverEnabled`,
   `src/hub/sync.ts`) is not uploaded. A log enabled even for 0.02 s uploads. A log with no `runs` reading uploads as
   before: one made before ADR 8's reading, and one that records no Enabled signal at all (another team's robot: 4 of 20
   public logs, real matches), for which the describer writes no `runs` (a log read again loses an earlier reading's
   "0 runs"). A log on the field is never held back, even with no enable: a match the robot sat dead through still goes up.
   Teammates need no change: a record is published only once its file is on the team
   store, so a held-back log is never in this laptop's published manifest, and no teammate's Library or the phone lists a
   log they could not open or download. Nothing on this laptop marks such a log as
   held: the only trace is the sync result's line and the line in `jobs.log`, written at every sync.
3. **Say so, and offer the way out.** The pull's result says "Skipped N logs from power-ons with no Driver Station attached
   (the robot was never enabled), X MB." with a "Pull them too" button, in the Now tab and the Library, and writes the same
   line to `jobs.log`. The sync's result says "Not uploaded: N logs the robot was never enabled in, X MB, kept on this laptop."
   with an "Upload them too" button, and writes the line to `jobs.log`. Both buttons run the same job again with a parameter
   (`includeNoDriverStation`, `includeNeverEnabled`); neither is a setting, so the next pull or sync skips again.

## Consequences

- A pull and a sync are shorter and the library holds what can be judged; the number left behind is always shown.
- A future rule about boots that never enabled (the start-up faults above, a motor lost on the stand) has no data from
  skipped boots until someone pulls them with "Pull them too". The rule's author must say so.
- Nothing is deleted anywhere: the robot's stick keeps every skipped file, and a log held back from the Drive is in the
  library on the laptop that pulled it.
- The name rule is AdvantageKit's. A robot that names its logs another way (DogLog, plain `DataLogManager`) is not
  affected on a pull; its never-enabled logs are held back at the sync only once the library has read them.
- A timestamp-named log that never enabled (4 of 36 above) is pulled, and held back only at the sync.
