# HindsightCompanionBattery

The battery half of the Hindsight companion library (`../README.md`). It was the standalone `FRC8033BatteryTracker`;
its log keys haven't changed. A WPILib vendor library that logs which battery is in the robot, so log analysis can follow each battery across
matches and spot a weak one (a battery that read fully charged but had low capacity has caused a brownout in a match).

It reads the battery's Playing With Fusion Battery Fuel Gauge. If there is no gauge, it falls back to a label typed on
the dashboard. Everything is logged through AdvantageKit, so it works in replay.

## Adopting it

1. In VS Code: **WPILib: Manage Vendor Libraries → Install new library (online)**, and paste the vendordep URL
   (TBD until it's hosted; until then, see "Building and publishing"). The project must already have AdvantageKit and
   the PlayingWithFusion vendordep. The vendordep is `HindsightCompanionBattery.json`.
2. In `Robot.java`:

   ```java
   import com.frc8033.hindsight.battery.BatteryGaugeIO;
   import com.frc8033.hindsight.battery.BatteryGaugeIOReal;
   import com.frc8033.hindsight.battery.BatteryTracker;

   // Fuel gauge CAN ID: every battery's gauge must use this one
   private final BatteryTracker batteryTracker =
       new BatteryTracker(isReal() ? new BatteryGaugeIOReal(0) : new BatteryGaugeIO() {});

   // in robotPeriodic():
   batteryTracker.periodic();
   ```

3. Give each gauge a nickname that matches the label on its battery (e.g. `B07`), using PWF's tools. If a gauge has no
   nickname, its ID is logged as `BFG-<serial>`.

## What it logs

| Key | What |
|---|---|
| `Battery/Id` | The battery's ID: gauge nickname (trimmed, upper-cased), else `BFG-<serial>`, else the typed label |
| `Battery/IdSource` | `gauge`, `gauge-cached` (the gauge dropped out; this is its last ID since boot), `dashboard` or `none` |
| `BatteryGauge/*` | `Connected`, `Valid`, `SerialNumber`, `Nickname`, `EffectiveCapacityAh`, `RatedCapacityAh`, `RemainingChargePct`, `NumCycles`, `BatteryAgeDays` |

The gauge is read once a second. A reading is `Valid` only when the gauge is connected, its serial is nonzero and its
rated capacity is between 0 and 100 Ah: in-season snapshots include gauges that reported serial 0 and junk values.
When `Valid` is false, the other `BatteryGauge/*` fields are zero.

## Dashboard field and alerts

- `BatteryId` (SmartDashboard): type the battery's label here only when it has no working gauge. The dashboard can
  send the old label back after a reboot, so retype it after every battery swap. The robot clears it when teleop of
  an FMS match ends.
- Alerts: "Battery ID unknown" (warning), "Battery fuel gauge not connected or not reporting" (warning, real robot
  only), the typed ID in use (info), and a typed ID that doesn't match the gauge (warning).

## Check on the bench before an event

- The gauges answer on the CAN ID you pass. Every battery's gauge must use the same ID.
- How long a gauge read takes with the gauge unplugged. The getters are JNI calls; whether they wait on CAN isn't
  visible from Java.
- Whether your dashboard re-sends an old `BatteryId` after the robot reboots.

## Building and publishing

It builds with the rest of the companion library, from `companion/`: see `../README.md`. Its vendordep is written
to `battery/build/vendordep/HindsightCompanionBattery.json`. WPILib, AdvantageKit and the PWF library are
compile-only: the robot project provides them, so none is bundled.
