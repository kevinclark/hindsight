# Hindsight companion library

A WPILib vendor library for robots that log with AdvantageKit. It logs the few things Hindsight and Foresight need
that nothing else logs, and raises Alerts (shown in Elastic) when one of them is wrong. It never replaces
AdvantageKit's own logging, Phoenix's hoot recording or PhotonVision; anything they already log is left to them.

It comes as two vendordeps:

| Vendordep | Package | Needs | What it logs |
|---|---|---|---|
| `HindsightCompanion` | `com.frc8033.hindsight` | AdvantageKit, Phoenix 6 | CANivore bus status, roboRIO CPU and memory, Java heap, log drive space |
| `HindsightCompanionBattery` | `com.frc8033.hindsight.battery` | AdvantageKit, PlayingWithFusion | which battery is in the robot (`battery/README.md`) |

A team without battery fuel gauges installs only the first.

## Adopting it

1. Install the vendordep: **WPILib: Manage Vendor Libraries → Install new library (online)** with its URL (not
   hosted yet; until then, build it as below and install the JSON from `core/build/vendordep/` offline).
2. In `Robot.java`:

   ```java
   import com.frc8033.hindsight.HindsightCompanion;

   // After the CANBus your code already makes. "/U" is the folder you give WPILOGWriter
   // (leave it out if you use WPILOGWriter's default, /U/logs)
   private final HindsightCompanion companion = new HindsightCompanion("/U", canBus);

   // in robotPeriodic():
   companion.periodic();
   ```

   Pass every CANivore's `CANBus`. A robot with no CANivore passes none and still gets CPU, memory and the log drive.

3. On the line right after you make each CTRE device (Talon FX or FXS, CANcoder, Pigeon 2, CANdi, CANrange, CANdle):

   ```java
   motor = new TalonFX(15, canBus);
   device = HindsightDevices.watch(motor);   // a String field: "Any/TalonFX/15"

   // in updateInputs, so the log says which keys belong to this device:
   inputs.device = device;                   // a String input, logged as <your IO's key>/Device
   ```

   The key is `<bus>/<model>/<id>`: the bus name (`CANBus("*")`, any CANivore, logs as `Any`; give your CANivore its
   real name so Foresight can match it to the right bus), the device's class name and its CAN id. The companion then logs whether the device is answering, its firmware, its live and sticky faults,
   and its reboots. It reads its own copies of the signals, so it never changes a rate, a config or your code's
   signal objects. A device you don't watch isn't logged, and nothing warns you in the robot code: Hindsight's
   Logging tab lists each motor, CANcoder and gyro the robot profile names with a CAN ID that has no watch entry.

## What it logs

Every key and its type is in `keys.json`. Everything is an AdvantageKit input, so a replay reads it back. The
hardware is read once a second, and only on a real robot; in simulation the values stay at their defaults.

| Keys | What | Read |
|---|---|---|
| `/Hindsight/CANivore/<bus>/` `UtilizationPercent`, `Status`, `BusOffCount`, `TxFullCount`, `Rec`, `Tec` | the CANivore's own bus status (`CANBus.getStatus()`). `<bus>` is the bus name; `CANBus("*")` logs as `Any` | once a second |
| `/Hindsight/System/` `CpuPercent`, `MemAvailableBytes`, `MemTotalBytes`, `HeapUsedBytes`, `HeapMaxBytes`, `Status` | roboRIO CPU (from two reads of `/proc/stat`), memory (`/proc/meminfo`), and the robot program's Java heap | once a second |
| `/Hindsight/LogDrive/` `Path`, `ResolvedPath`, `Device`, `OnUsb`, `FreeBytes`, `TotalBytes`, `Status` | the drive the log folder is on, from `/proc/mounts` | once, at boot |
| `/Hindsight/Devices/<bus>/<model>/<id>/` `Connected`, `Version`, `FaultField`, `StickyFaultField`, `ProLicensed`, `Resets`, `Status` | each device given to `HindsightDevices.watch`. `<model>` is the class name (`TalonFX`, `CANcoder`, ...); the fault fields hold every fault as a bit | once a second |
| `/Hindsight/Hoot/` `Recording`, `FilesWriting`, `NewestFile`, `NewestSizeBytes`, `SecondsSinceWritten`, `Status` | whether Phoenix's hoot recording is on. Phoenix has no call that says so, so it's a `.hoot` file in `/U/logs` or `/home/lvuser/logs` written in the last 5 s | once a second |

`Status` is `ok` (or Phoenix's `OK` for a CANivore or a device) when the values were read. Otherwise it says why: `not read`,
`first CPU sample`, or `unavailable: ...`. On a computer without `/proc`, it says `unavailable` and never throws.

## Alerts

| Alert | Level | When |
|---|---|---|
| CANivore busy | warning above 80 %, error above 90 % | CTRE: keep a bus under 90 %; its own example warns at 80 % |
| CANivore errors | error | the bus turned off since boot, or it can't be read (`Status` isn't `OK`) |
| CANivore error counters rising | warning, shown for 10 s | `Rec` or `Tec` went up since the last read |
| Log drive | warning below 600 MB free (about ten matches); error if the log isn't on a USB stick | at boot |
| Devices not answering | error | a watched device didn't answer in the last half second, or its status signals are turned off (`optimizeBusUtilization(0)`) |
| Devices rebooted | warning | a watched device rebooted while the code ran |
| Sticky faults | warning | a watched device has a sticky fault set: see Tuner X, and clear it only after the log is pulled |
| Firmware mismatch | warning | watched devices of one model run different firmware |

The battery module adds its own ("Battery ID unknown" and the others in `battery/README.md`).

## Not checked on a robot yet

- `/proc/stat`, `/proc/meminfo` and `/proc/mounts` on a roboRIO 2: readable, and cheap to read? The unit tests use
  synthetic files in the Linux format.
- That a USB stick on a roboRIO mounts from a `/dev/sd...` device, and that `/U` links to it.
- Whether `getStatus()` utilization on CAN FD is on the same scale as CTRE's 90 % guidance.
- Where hoot files go on a roboRIO 2, and how often they're written (sets the 5 s).
- The CPU cost of reading every watched device once a second (100 signal reads a second for 25 devices: 4 per device).
- In replay, a device's values are read back only if the replayed code watches it too.

## Building and publishing

JDK 17. From this folder, `./gradlew build` builds both vendordeps and runs the tests, including the one that checks
the library logs exactly the keys in `keys.json` (`tests/companion-keys.test.ts` checks the same file from
Hindsight's side). `./gradlew build publish -PmavenUrl=<maven repo URL> -PjsonUrl=<vendordep URL>` writes the Maven repo to
`build/repo` and the vendordeps to `core/build/vendordep/` and `battery/build/vendordep/`. Without `-PmavenUrl`, the
vendordeps point at the local `build/repo`, which is useful for testing against a robot project on the same machine.

WPILib, AdvantageKit, Phoenix and the PWF library are compile-only: the robot project provides them, so none is
bundled. Their versions are at the top of `build.gradle` (WPILib 2026.2.1, AdvantageKit 26.0.2, Phoenix 26.3.0,
PWF 2026.5.08).
