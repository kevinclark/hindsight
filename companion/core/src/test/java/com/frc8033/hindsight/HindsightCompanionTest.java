package com.frc8033.hindsight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.frc8033.hindsight.CanivoreIO.CanivoreIOInputs;
import com.frc8033.hindsight.LogDriveIO.LogDriveIOInputs;
import com.frc8033.hindsight.SystemIO.SystemIOInputs;
import edu.wpi.first.wpilibj.Alert.AlertType;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class HindsightCompanionTest {
  /** One alert as the robot would show it. */
  static final class ShownAlert implements HindsightCompanion.AlertOut {
    final AlertType type;
    boolean active = false;
    String text = "";

    ShownAlert(AlertType type) {
      this.type = type;
    }

    @Override
    public void set(boolean active, String text) {
      this.active = active;
      this.text = text;
    }
  }

  /** Stands in for the hardware: counts reads, and hands back whatever the test set. */
  static final class FakeHardware implements SystemIO, LogDriveIO, CanivoreIO {
    int systemReads = 0;
    int logDriveReads = 0;
    int canivoreReads = 0;
    boolean throwOnRead = false;
    LogDriveIOInputs drive = new LogDriveIOInputs();
    CanivoreIOInputs bus = new CanivoreIOInputs();

    @Override
    public void updateInputs(SystemIOInputs inputs) {
      systemReads++;
      if (throwOnRead) {
        throw new IllegalStateException("boom");
      }
      inputs.status = "ok";
    }

    @Override
    public void updateInputs(LogDriveIOInputs inputs) {
      logDriveReads++;
      inputs.status = drive.status;
      inputs.path = drive.path;
      inputs.onUsb = drive.onUsb;
      inputs.freeBytes = drive.freeBytes;
    }

    @Override
    public void updateInputs(CanivoreIOInputs inputs) {
      canivoreReads++;
      if (throwOnRead) {
        throw new IllegalStateException("boom");
      }
      inputs.status = bus.status;
      inputs.utilizationPercent = bus.utilizationPercent;
      inputs.busOffCount = bus.busOffCount;
      inputs.rec = bus.rec;
      inputs.tec = bus.tec;
    }
  }

  final FakeHardware hardware = new FakeHardware();
  final List<ShownAlert> alerts = new ArrayList<>();

  HindsightCompanion companion(boolean real) {
    return new HindsightCompanion(
        real,
        hardware,
        hardware,
        Map.of("Any", hardware),
        type -> {
          ShownAlert alert = new ShownAlert(type);
          alerts.add(alert);
          return alert;
        });
  }

  List<String> shown() {
    return alerts.stream().filter(a -> a.active).map(a -> a.type + ": " + a.text).toList();
  }

  /** Runs whole seconds of 50 loops, so each second ends just after a read. */
  static void runSeconds(HindsightCompanion companion, int seconds) {
    for (int i = 0; i < seconds * HindsightCompanion.READ_PERIOD_LOOPS; i++) {
      companion.periodic();
    }
  }

  @Test
  void nothingReadsHardwareInReplayOrSimulation() {
    HindsightCompanion companion = companion(false);
    runSeconds(companion, 10);
    assertEquals(0, hardware.systemReads + hardware.logDriveReads + hardware.canivoreReads);
    assertEquals(List.of(), shown());
  }

  @Test
  void readsOnceASecondAndTheLogDriveOnlyAtBoot() {
    HindsightCompanion companion = companion(true);
    runSeconds(companion, 3);
    assertEquals(3, hardware.systemReads);
    assertEquals(3, hardware.canivoreReads);
    assertEquals(1, hardware.logDriveReads);
  }

  @Test
  void aFailedReadIsLoggedNotThrown() {
    hardware.throwOnRead = true;
    HindsightCompanion companion = companion(true);
    companion.periodic();
    List<String> statuses = new ArrayList<>();
    companion.forEachInputs(
        (key, inputs) -> {
          org.littletonrobotics.junction.LogTable table =
              new org.littletonrobotics.junction.LogTable(0);
          inputs.toLog(table);
          statuses.add(key + " " + table.get("Status", ""));
        });
    assertTrue(statuses.contains("Hindsight/System unavailable: IllegalStateException"), statuses.toString());
    assertTrue(statuses.contains("Hindsight/CANivore/Any unavailable: IllegalStateException"));
  }

  @Test
  void busyCanivoreWarnsAbove80AndErrsAbove90() {
    hardware.bus.status = "OK";
    hardware.bus.utilizationPercent = 50;
    HindsightCompanion companion = companion(true);
    runSeconds(companion, 1);
    assertEquals(List.of(), shown());

    hardware.bus.utilizationPercent = 85;
    runSeconds(companion, 1);
    assertEquals(List.of("kWarning: CANivore Any bus 85.0% busy (warning above 80%)"), shown());

    hardware.bus.utilizationPercent = 95;
    runSeconds(companion, 1);
    assertEquals(List.of("kError: CANivore Any bus 95.0% busy (CTRE: keep under 90%)"), shown());
  }

  @Test
  void busOffSinceBootAndUnreadableBusAreErrors() {
    hardware.bus.status = "OK";
    hardware.bus.busOffCount = 4; // from before this code started: not counted
    HindsightCompanion companion = companion(true);
    runSeconds(companion, 1);
    assertEquals(List.of(), shown());

    hardware.bus.busOffCount = 6;
    runSeconds(companion, 1);
    assertEquals(List.of("kError: CANivore Any bus turned off 2 times since boot"), shown());

    hardware.bus.status = "InvalidNetwork";
    runSeconds(companion, 1);
    assertEquals(List.of("kError: CANivore Any can't be read: InvalidNetwork"), shown());
  }

  @Test
  void busOffsStillCountAfterTheCanivoreRestarts() {
    hardware.bus.status = "OK";
    hardware.bus.busOffCount = 4;
    HindsightCompanion companion = companion(true);
    runSeconds(companion, 1);
    hardware.bus.busOffCount = 0; // the CANivore restarted
    runSeconds(companion, 1);
    assertEquals(List.of(), shown());
    hardware.bus.busOffCount = 1;
    runSeconds(companion, 1);
    assertEquals(List.of("kError: CANivore Any bus turned off 1 times since boot"), shown());
  }

  @Test
  void risingErrorCountersWarnForTenSeconds() {
    hardware.bus.status = "OK";
    HindsightCompanion companion = companion(true);
    runSeconds(companion, 1);
    hardware.bus.tec = 8;
    runSeconds(companion, 1);
    assertEquals(List.of("kWarning: CANivore Any bus errors rising (receive 0, transmit 8)"), shown());

    hardware.bus.tec = 0;
    runSeconds(companion, 9);
    assertFalse(shown().isEmpty());
    runSeconds(companion, 2);
    assertEquals(List.of(), shown());
  }

  @Test
  void logDriveOffUsbIsAnErrorAndLowIsAWarning() {
    hardware.drive.status = "ok";
    hardware.drive.path = "/U";
    hardware.drive.onUsb = false;
    HindsightCompanion offUsb = companion(true);
    offUsb.periodic();
    assertEquals(List.of("kError: Robot log isn't going to a USB stick: /U is on the roboRIO"), shown());

    alerts.clear();
    hardware.drive.onUsb = true;
    hardware.drive.freeBytes = 450_000_000L;
    HindsightCompanion low = companion(true);
    low.periodic();
    assertEquals(
        List.of("kWarning: Log drive has 450 MB free (want 600 MB, about ten matches)"), shown());
  }

  @Test
  void busNamesBecomeKeyNames() {
    assertEquals("Any", HindsightCompanion.label("*"));
    assertEquals("rio", HindsightCompanion.label(""));
    assertEquals("canivore", HindsightCompanion.label("canivore"));
    assertEquals("a_b", HindsightCompanion.label("a/b"));
  }
}
