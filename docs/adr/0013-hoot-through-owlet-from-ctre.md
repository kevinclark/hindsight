# 13. .hoot files are read only through CTRE's owlet, which the user gets from CTRE

Status: accepted, 2026-11-09

## Context

CTRE's Phoenix 6 logs every CTRE device's signals to `.hoot` files, one per CAN bus: supply voltage, current,
temperature and faults per device, which an AdvantageKit log does not carry. On our own robot's files, the only bridge
brownout in 51 enabled minutes was visible only in the `.hoot`. The format is proprietary. The only reader is CTRE's
owlet, under CTRE's licence (`CTRE_LICENSE.txt` in CTRE's Phoenix-Releases repository), which:

- grants each user a licence to "download, install and use" the software;
- forbids distributing, transmitting, hosting or making the software available to anyone else, and says owlet may be
  re-distributed only with CTRE's express permission;
- forbids reverse engineering or decompiling any part of it.

AdvantageScope reads `.hoot` the same way: it asks the user to accept CTRE's licence once, then downloads owlet from
CTRE's own index (`https://redist.ctr-electronics.com/index.json`) and runs it. CTRE's licence itself binds by use: "By
downloading, installing, accessing, or using the Software you are agreeing to be bound by the terms and conditions of
this Agreement", an agreement "between you" and CTRE.

## Decision

1. owlet is found or fetched, never shipped: no owlet binary in this repository, in a build, on the team's Drive or in
   any store Hindsight shares. CI never downloads it (the tests run a fake).
2. Hindsight does not stand between the user and CTRE's licence: no checkbox, no acceptance kept. An owlet already on
   the computer is used as it is. Where there is none, the download button sits beside a line saying that downloading
   owlet means agreeing to CTRE's licence, linked (Kevin, 2026-11-09; the first build asked with a checkbox, as
   AdvantageScope does).
3. Hindsight looks in its own owlet folder first, then AdvantageScope's cache, for the highest version that reads the
   file's format (byte 70 of the `.hoot`). The download button shows only when neither has one.
4. A download comes from CTRE's index: the newest owlet for the file's format with a build for this computer (every Mac
   takes `macosuniversal`, Windows on Arm the x64 build, as AdvantageScope does), only from CTRE's address with no
   redirect followed, checked against CTRE's sha-1 before it is written, saved as `owlet-<version>-C<format>`.
5. No `.hoot` parser of our own, ever: only owlet reads the format.
6. What owlet exports is reduced to what the Devices tab draws and cached per `.hoot` (`<userData>/hoot-cache`), never in
   the library, which Sync uploads. The first build is a view: no rule, finding, phone card or event line reads it.
   (Superseded by ADR 14: experimental rules read it, in a tier of their own; phone cards and event lines still don't.)

The robot snapshot tool (`tools/robot-snapshot.py`) stays as it is: it runs the owlet in AdvantageScope's cache in place
and never downloads one.

## Ruled out

- Bundling owlet in Hindsight's builds, or hosting a copy on the team's Drive or a release: distribution.
- A `.hoot` reader of our own: reverse engineering.
- Downloading owlet in CI to test against: the tests run a fake owlet and a made-up index.

## Consequences

Reading a `.hoot` costs nothing with AdvantageScope's owlet on the computer, else one click per laptop. The robot profile names no CAN bus, so a device is
named from the profile only when its CAN id is unique in the profile and found on one of the log's `.hoot` files.
A `.hoot` is lined up with its robot log by the enables and disables both record; a file with fewer than two that pair
up (a match's `.hoot` that Phoenix started mid-match) is drawn on its own clock and says so. Files without a Phoenix Pro
licence have not been tried: all of ours are Pro, and owlet's own words are shown if one fails. Windows and Linux have
not been run.
