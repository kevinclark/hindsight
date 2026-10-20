# Robot snapshot

A robot snapshot records what every CTRE (Phoenix 6) device on the robot says about itself:

- its model, CAN ID, firmware, and whether it is Pro-licensed;
- the current limits each motor is **really** running, which can differ from what the code sets;
- its **sticky faults**: problems the device saw at least once since someone last cleared them, like a voltage sag
  or a restart while the robot was enabled.

A small program on the laptop reads all of this from the robot and saves it in a file. Hindsight then compares that
file with your robot profile. The program only reads. It never changes a setting, moves a motor or clears a fault.

## Get it (no Python needed)

1. Open the Releases page: https://github.com/kevinclark/hindsight/releases
2. Download `robot-snapshot-mac.zip` (Mac) or `robot-snapshot-windows.zip` (Windows) and unzip it.
3. Double-click `robot-snapshot` (`robot-snapshot.exe` on Windows). It asks for your team number: type it and press
   Enter, or just press Enter if the robot is plugged in by USB. The window stays open at the end so you can read it.

The first time only, because the files are not signed:

- **Mac:** if it says it can't be opened, go to System Settings, Privacy & Security, scroll down and click
  **Open Anyway**, then double-click it again.
- **Windows:** if it says "Windows protected your PC", click **More info**, then **Run anyway**.

The hoot options and `--address` need the command line (Terminal on a Mac, PowerShell on Windows), for example
`./robot-snapshot --hoot-list` in the unzipped folder (`.\robot-snapshot.exe --hoot-list` on Windows). On Windows the program does not check for a VPN on the
robot's address (only macOS and Linux do), so switch any VPN off yourself.

Running it from source with Python is described below.

## Before you start: what not to press

- **Don't press "Clear Faults" in Phoenix Tuner X, and don't blink any device,** until the snapshot is saved.
  Both erase the sticky faults the snapshot exists to read.
- Don't enable the robot for this. It doesn't need to be enabled.
- If Phoenix Tuner X is open, leave it alone while the snapshot runs.

## What you need

- The robot turned on, with the robot code running. The code starts the reader the program talks to (CTRE's
  diagnostic server).
- A USB cable from the laptop to the roboRIO's USB port. Over the robot's Wi-Fi also works, see below.
- Python 3.8 or newer (not needed if you use the download above). Check with `python3 --version`. On a Mac that has never had it, that command offers to
  install Apple's command line tools, which include Python: say yes and wait a few minutes.
- No VPN switched on. A VPN can capture the robot's address, and then the program stops before it starts.
- This repository's `tools/robot-snapshot.py`. It is one file, so you can copy just that file.

## The one command

In a terminal, in this repository's folder:

```bash
python3 tools/robot-snapshot.py
```

Over the robot's Wi-Fi instead of USB, give your team number (here 1234):

```bash
python3 tools/robot-snapshot.py --team 1234
```

It prints each device as it reads it, then the folder it saved to. That folder is
`robot-snapshots/<date>_<time>/` in your home folder. It holds:

- `snapshot.json`: what you drop into Hindsight;
- `README.txt`: what was collected and what wasn't.

It takes a few seconds. Run it again any time: each run makes a new folder and never overwrites an old one.

**If it says STOPPED,** the robot answered with an error or didn't answer in time. The program doesn't retry. It
still saves what it got, marked incomplete. Check that the cable is in and that the robot code is running, then run
it once more. If it stops again, send the folder to a mentor.

## Look at it in Hindsight

Open `hindsight.html`, choose **Robot snapshot** at the top, and drop `snapshot.json` onto the page. Hindsight
picks the robot profile whose CAN IDs it finds on the bus. You can choose another one from the list.

- **Sticky faults** come first. Undervoltage, BridgeBrownout and BootDuringEnable are the power problems: the
  battery voltage sagged, or the device restarted while enabled. A sticky fault says it happened since the faults
  were last cleared, not that it is happening now. Once the snapshot is saved, a mentor decides whether to clear
  them.
- **Inventory** compares the bus with the profile. It shows motors that are **missing**, two devices that share
  one CAN ID (a **duplicate ID**), and motors that are **not in the profile**. A motor the profile gives no CAN ID
  can't be checked.
- **Current limits** shows, for each mechanism, every motor's six current-limit settings next to what the code sets.
  A red value means that motor isn't running what the code says. There are two usual reasons: the code's `apply()`
  failed when the robot started, or someone changed it in Phoenix Tuner X. A deploy or a restart puts the code's
  values back. A supply limit that is switched off is called out, because then nothing limits the current that motor
  draws from the battery.

**Before and after:** drop a second snapshot, for example one taken after a fix, and the page lists exactly what
changed: devices, firmware, settings, sticky faults. Live readings like voltage are left out.

**Limits wizard:** each step's "Check it" card also takes a `snapshot.json`. Take one after you set the limit in
Phoenix Tuner X. It proves the setting reached every motor in the group, followers included.

## Use it in Foresight (the pit check)

Foresight's pit checklist has four lines only a snapshot can tick: *All CAN devices licensed and ID'd*, *CANcoder
offsets correct and unchanged*, *Swerve ratio unchanged*, and *Current limits as the code sets them*. Foresight never
talks to the diagnostic server itself; you give it the snapshot.

1. Connect Foresight to the robot and wait until it shows a verdict (GO, NO-GO or NOT CHECKED).
2. Run `python3 tools/robot-snapshot.py` on the same laptop: the one you run checks from, which need not be (and for
   8033 never is) the drive laptop. If you must use a second laptop, copy `snapshot.json` across and set both clocks
   automatically. Don't press Clear Faults or blink anything first.
3. Click **Robot snapshot…** under the Connect button, or drop `snapshot.json` on that box.

The box then says whether the snapshot was used. Foresight uses a snapshot only when it was taken at least 30 s
after the robot code last started, by the laptop's clock: the code sets every device's offsets, ratios and limits
when it starts, so an older snapshot says nothing about what the devices run now. Restart the robot code or deploy,
or change anything in Phoenix Tuner X, and you need a new snapshot: Foresight can catch the first two but not a Tuner
X change. The snapshot's time is when the program started reading, so a slow run is judged by its start. Until a
snapshot is used, those four lines say "Not checked" and why. A line whose check could read only part of what it
needs (one CANcoder's offset, say) also says "Not checked", with what was missing.

What each line checks:

- **Licensed and ID'd:** every motor in the profile, every CANcoder and the gyro answer on their own CAN ID, nothing
  shares an ID, no motor is on the bus that the profile doesn't list, and none of those devices reports using a
  Phoenix Pro feature without a licence (for example a steer motor fused with its CANcoder). A sticky licence fault
  is shown as one: it happened since faults were last cleared, and stays until a mentor clears it. Other CTRE
  devices the profile doesn't list (a CANdle) are mentioned as context and not checked for licences.
- **CANcoder offsets:** each CANcoder runs the magnet offset the code sets (within 0.001 rotation, 0.36°), and each
  swerve steer motor (and the intake pivot) reads its own CANcoder. Whether the code's offsets are *right*, with
  the wheels pointing straight, is still for a person to look at.
- **Swerve ratio:** every drive and steer motor runs the code's gear ratio (within 0.1 %, so a wheel radius 1 % off
  shows).
- **Current limits:** the same comparison as the Current limits section above, every motor, followers included.

Everything found here is amber ("look at"), never red: no snapshot of our robot has been taken yet, so none of
these checks has caught a real fault. The expected values live in the robot profile
(`foresight.snapshot` in `src/profiles/2026-offseason.ts`), copied from the robot code with the line each came from.
When the code changes an offset, ratio or ID, update the profile too.

## Phoenix hoot logs (optional)

Phoenix can record every device signal in `.hoot` log files on the roboRIO. The program can list them, copy the
ones you name, and convert them so Hindsight can open them.

1. **Once per season:** open any `.hoot` file in AdvantageScope. AdvantageScope asks you to accept CTRE's licence
   for their converter (owlet) and then keeps a copy. This program uses that copy. It never downloads owlet itself.
2. List the files on the robot:

   ```bash
   python3 tools/robot-snapshot.py --hoot-list
   ```

   When ssh asks for a password, press Enter. The roboRIO's `lvuser` account has none. Each copy asks again: press
   Enter each time.
3. Copy and convert the ones you want by part of their name, for example qualification match 28:

   ```bash
   python3 tools/robot-snapshot.py --hoot-copy '*_Q28_*'
   ```

   If copying fails with an SFTP error, add `--scp-legacy`.

The converted `.wpilog` files land in the run's `hoot/` folder. Open them in Hindsight's Match review. Phoenix
writes one file per CAN bus: `rio` for the roboRIO's own bus, and one per CANivore, named by its serial number.
Each holds the devices on its bus. Without Pro licences a converted file may hold only some signals, or only the
robot's enable state (RobotEnable and RobotMode).

To line a hoot log up with the robot's own log, match the moments the robot was enabled (`RobotEnable`). Don't go
by the times in the file names: on one robot those were off by several seconds, in both directions.

Already have `.hoot` files on the laptop? Convert them without a robot:

```bash
python3 tools/robot-snapshot.py --hoot-file path/to/file.hoot
```

## What the program never does

- It only sends five read requests to the robot: `getversion`, `getdevices`, `getsignals`, `getconfigv2` and
  `decoratedselftest`. Every other request, including the ones that blink a device, change a setting or move a
  motor, is impossible by design, and a test checks that.
- It never retries a failed request, and it never goes through a proxy or follows a redirect.
- Over ssh it only lists files (`ls`) and copies files from the robot to the laptop (`scp`).
- It writes only its own output folder, and it refuses to write inside a git repository.

## Not confirmed yet

So far the program has only been checked against CTRE's simulator, not a real robot. For Foresight's checks, the
config and fault names it looks for come from Phoenix 6 (26.3.0) itself, not from a real robot's answers:
`CANCoder_MagnetOffset` (the simulator fixture spells it `Config_MagnetOffset`; both are read),
`Config_SensorToMechanismRatio`, `Config_RotorToSensorRatio`, `Config_FeedbackRemoteSensorID`, and any
`Fault_…`/`StickyFault_…` with `Unlicensed` in its name. The model names `CANcoder…` and `Pigeon 2` are assumed too. If
a real robot names them differently, those lines say "Not checked" with what wasn't read, never OK. The first real
run will show whether a real robot answers the same way. Anything Hindsight marks as "unreadable" is a sign it doesn't.
Hindsight also can't yet tell whether the robot allows a web page to read the diagnostic server directly. The
snapshot records that (the CORS line). If it does, a later version may collect from the page itself.
