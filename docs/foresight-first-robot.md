# Foresight on the robot for the first time (about 5 minutes, in the pit)

Everything about Foresight so far ran against replayed logs and a desktop copy of ntcore (pyntcore 2025.3.2), never a
roboRIO. This run checks the parts only a real robot can: that the page connects from the DS laptop, that the robot
publishes what Foresight reads under `/AdvantageKit`, and that the robot's clock and start time come through.

**Where:** the pit, robot on its cart, tethered to the DS laptop by USB (or Ethernet). Later it runs in the queue too,
as part of the team's onchecks; this first run is in the pit. **Never on the field.** Nothing here moves the robot or
writes to it: Foresight only subscribes.

## Before you start

- `hindsight.html` built from the commit that added Foresight or later (`npm run build` in the Hindsight repo),
  copied to the DS laptop.
- Robot on, robot code running, Driver Station open and showing Communications green, robot **disabled**.
- Both controllers plugged into the DS laptop.

## Steps

1. **Open the page from a file.** Double-click `hindsight.html` on the DS laptop (its address bar shows `file://`).
   Click **Foresight** at the top.
2. **Connect.** Robot: `172.22.11.2` for USB, `10.80.33.2` for Ethernet. Click **Connect**. Within about 5 s the line
   next to the button should say `Connected. Robot: 2026 offseason robot (<branch>); reading 66 signals.`
   If it says it cannot tell the robot is in the pit, or the connection closes: go to step 8 and note the message.
3. **Check the counts** under **Readings**: *Topics announced / signals asked for*. Replaying the CalGames logs gives
   55 / 66: 54 of the 66 signals are in those logs (the 12 missing are the battery tracker's, which the robot code
   doesn't log yet), plus WPILib's `/FMSInfo/FMSControlData` for the field guard. Note both numbers. *Values received* should climb every second.
4. **Check the clock.** *Robot time* should read `… s · code started at … s (from the metadata)`. Note whether it says
   *from the metadata* or *from the first value*, and whether the code-start time looks right (just after a reboot
   the CalGames logs started at 11.8–12.2 s). From the metadata, a robot already on for 30 s skips the countdown.
5. **Compare three live values with the Driver Station:**
   - *Battery now* against the DS battery voltage (within 0.05 V);
   - *Controllers*: ports 0 and 1 both name a controller (unplug one: within a couple of seconds a "Controller
     missing" item appears; plug it back and it clears);
   - *Code*: the GitSHA and branch match what was deployed.
6. **Wait for the verdict.** Until 30 s after the robot code started it shows a countdown, then GO, NO-GO or NOT
   CHECKED with the findings. Note the verdict and any items.
7. **Note the versions:** the browser (Chrome: menu → Help → About; Edge: Settings → About) and the roboRIO image
   (Driver Station → Diagnostics tab, or the roboRIO's web page).
8. **Save the record.** Click **Download for Claude** under Readings. It saves `foresight-readings-<time>.json`: the
   counts, clock, verdict, browser, and the list of signals the robot never sent. Add the roboRIO image version from
   step 7 in a note next to it.
9. **Disconnect and close the page.** Click **Disconnect**, then close the tab.

## What can't be checked in the pit

- **The field guard** needs the field: the Driver Station's practice mode does not set FMS attached. It is tested
  against replayed CalGames logs (it closes at the attach, 27.3–28.5 s robot time) and against ntcore, but not
  against a real field.
- Whether **AdvantageKit's values carry the robot's own timestamps** on the roboRIO (so robot time matches the log)
  is assumed from AdvantageKit's source; step 4 shows it.
