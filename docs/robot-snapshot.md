# Robot snapshot

A robot snapshot records what every CTRE (Phoenix 6) device on the robot says about itself:

- its model, CAN ID, firmware, and whether it is Pro-licensed;
- the current limits each motor is **really** running, which can differ from what the code sets;
- its **sticky faults**: problems the device saw at least once since someone last cleared them, like a voltage sag
  or a restart while the robot was enabled.

A small program on the laptop reads all of this from the robot and saves it in a file. Hindsight then compares that
file with your robot profile. The program only reads. It never changes a setting, moves a motor or clears a fault.

## Before you start: what not to press

- **Don't press "Clear Faults" in Phoenix Tuner X, and don't blink any device,** until the snapshot is saved.
  Both erase the sticky faults the snapshot exists to read.
- Don't enable the robot for this. It doesn't need to be enabled.
- If Phoenix Tuner X is open, leave it alone while the snapshot runs.

## What you need

- The robot turned on, with the robot code running. The code starts the reader the program talks to (CTRE's
  diagnostic server).
- A USB cable from the laptop to the roboRIO's USB port. Over the robot's Wi-Fi also works, see below.
- Python 3.8 or newer. Check with `python3 --version`. On a Mac that has never had it, that command offers to
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

So far the program has only been checked against CTRE's simulator, not a real robot. The first real run will show
whether a real robot answers the same way. Anything Hindsight marks as "unreadable" is a sign it doesn't.
Hindsight also can't yet tell whether the robot allows a web page to read the diagnostic server directly. The
snapshot records that (the CORS line). If it does, a later version may collect from the page itself.
