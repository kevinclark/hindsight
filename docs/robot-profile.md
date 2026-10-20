# Your robot's profile

Hindsight checks a match log against a **robot profile**: which log keys are your motors, how they group, their CAN
IDs and current limits. Without one, a log from your robot only gets the general checks (battery, comms, loop time),
and every check about a specific motor says "not checked". You don't write a profile by hand. Hindsight drafts one
from files you already have, and you confirm what it couldn't tell.

## 1. Drop what you have

Open `hindsight.html`, choose **Robot profile**, and drop:

| File | Where it comes from | What it gives |
|---|---|---|
| One or more match logs (`.wpilog`) | the roboRIO's USB stick or `/home/lvuser/logs` | your motors, how they group, the standard signals, which code ran (branch and commit) |
| `snapshot.json` (optional, best) | `python3 tools/robot-snapshot.py` with the robot on (see `robot-snapshot.md`) | each Talon FX's CAN ID and bus, and the current limits it is really running |
| Your robot-code folder (optional) | **Choose code folder…**; nothing in it is changed or uploaded | hints: where the code builds each Talon FX, and with which CAN ID |

Several logs draft better than one: a key that only some matches logged is still found. Only logs of one robot are
used (the latest log's code name); logs of another robot are listed and left out. Dropping another log later keeps
what you already confirmed.

Hindsight finds a motor when the log has a `struct:TalonFX` entry for it, or a current key (`…SupplyCurrentAmps`,
`…StatorCurrentAmps`, `…CurrentAmps`) with the same motor's velocity, voltage, temperature or connected key beside
it. A bare `Current` with no unit (`/Arm/Position/Current`) is often a present value, so a velocity beside it isn't
enough: it needs a voltage, temperature or connected key. It does not use `/RealOutputs` (computed values), dashboard tables (`SmartDashboard`, `Elastic`), or currents
logged as arrays; those are listed under **Seen, not used**.

## 2. Confirm

Everything Hindsight guessed is marked. Check, top to bottom:

1. **Robot name, game timings.** The auto and teleop lengths are measured from your latest log (by file name): fix them
   if that log wasn't a full match.
2. **Warnings.** "Only 2 motors found" means the log doesn't name most of your motors, so the battery and main
   breaker checks would read too low.
3. **Supply or stator?** A key like `DriveCurrentAmps` doesn't say. Pick the one your code logs
   (`getSupplyCurrent()` or `getStatorCurrent()`). Until you do, that motor's current isn't used.
4. **CAN ID**, one dropdown per motor. Pre-filled when the log names the ID, when the Talon FX is named in Phoenix
   Tuner X with the same words as the log ("Shooter Leader"), or when it is the only one left. Code hints are shown
   next to each ID. Naming your devices in Tuner X makes this step fill itself next time.
5. **Groups.** Swerve modules and a leader with its followers are grouped for you. Merge, split or rename the rest:
   one group per set of motors that share a current limit. Each group needs its own name: findings name a group by it,
   and a warning says when two groups are called the same. Tick **these motors run one control loop** only when they
   are a leader and followers that should spin at the same speed (leader/follower groups come ticked: confirm).
6. **Limits** come from the snapshot, labelled "as running on the robot". If a group's motors run different limits,
   it says so: split the group or fix the motors.

**Not checked with a drafted profile:** zeroing mechanisms, cameras, and the Power tab's what-if. Those checks list
under "Not checked".

## 3. Where it's kept

- **Keep in this browser** stores it in this browser on this computer, listed as "<name> @ <branch> (kept in this
  browser)" wherever a robot is chosen. Keeping a profile you opened from the kept list replaces it, even after a rename. Logs you drop after that are matched to it by
  the code name in the log (`Codebase` or `ProjectName`) in Match review and the Session view. Logs already loaded keep
  their old choice: drop them again, or choose it with **use…** / **Robot for this session**.
- **Save profile.json** downloads it. Commit it next to your robot code, or share it; dropping it here loads it again.
  A private window, or a browser that blocks storage for pages opened from disk, doesn't keep it, so save the file.

When your robot changes (new mechanism, new CAN IDs, new limits), drop a new log and snapshot and confirm again.
