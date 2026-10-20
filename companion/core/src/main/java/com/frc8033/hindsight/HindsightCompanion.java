package com.frc8033.hindsight;

import com.ctre.phoenix6.CANBus;
import edu.wpi.first.wpilibj.Alert;
import edu.wpi.first.wpilibj.Alert.AlertType;
import edu.wpi.first.wpilibj.RobotBase;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Consumer;
import org.littletonrobotics.junction.Logger;
import org.littletonrobotics.junction.inputs.LoggableInputs;

/**
 * Logs what nothing else logs, so Hindsight and Foresight can check it: each CANivore's own bus
 * status, the roboRIO's CPU and memory, the Java heap, and the log drive's free space. Everything
 * goes through AdvantageKit under /Hindsight/..., as inputs, so a replay reads it back.
 *
 * <p>Call {@link #periodic()} once per loop from robotPeriodic. The hardware is read once a second
 * (every 50 loops), and only on a real robot. It raises Alerts (shown in Elastic) when a CANivore
 * is busy or has errors, and when the log drive is low or isn't the USB stick.
 */
public class HindsightCompanion {
  /** Read once a second: getStatus() can block for up to 1 ms, and these values change slowly. */
  static final int READ_PERIOD_LOOPS = 50;

  /** CTRE: keep a CANivore under 90 %; its own API example warns at 80 %. */
  static final double BUSY_PERCENT = 80.0;

  static final double TOO_BUSY_PERCENT = 90.0;

  /** Ten matches at about 55 MB each (measured on our 2026 logs), so an event day fits. */
  static final long LOW_LOG_DRIVE_BYTES = 600_000_000L;

  /** A rising error counter stays shown this long, so it's seen in the pit (a guess, 10 s). */
  static final int ERROR_COUNTERS_SHOWN_LOOPS = 10 * 50;

  /** Shows or hides one alert. Tests use their own, so they run without NetworkTables. */
  interface AlertOut {
    void set(boolean active, String text);
  }

  interface AlertMaker {
    AlertOut make(AlertType type);
  }

  private final boolean real;
  private final SystemIO systemIO;
  private final SystemIOInputsAutoLogged systemInputs = new SystemIOInputsAutoLogged();
  private final LogDriveIO logDriveIO;
  private final LogDriveIOInputsAutoLogged logDriveInputs = new LogDriveIOInputsAutoLogged();
  private final List<Canivore> canivores = new ArrayList<>();
  private final AlertOut logDriveLow;
  private final AlertOut logDriveNotUsb;
  private int loopCount = 0;

  /**
   * Watches each CANivore given, and the log drive at AdvantageKit's default folder, /U/logs.
   *
   * @param canivores the CANBus objects your code already made for its CANivores
   */
  public HindsightCompanion(CANBus... canivores) {
    this("/U/logs", canivores);
  }

  /**
   * @param logDirectory the folder your code gives AdvantageKit's WPILOGWriter, e.g. "/U"
   * @param canivores the CANBus objects your code already made for its CANivores
   */
  public HindsightCompanion(String logDirectory, CANBus... canivores) {
    this(
        RobotBase.isReal(),
        new SystemIOReal(),
        new LogDriveIOReal(logDirectory),
        realCanivores(canivores),
        type -> {
          Alert alert = new Alert("", type);
          return (active, text) -> {
            alert.setText(text);
            alert.set(active);
          };
        });
  }

  HindsightCompanion(
      boolean real,
      SystemIO systemIO,
      LogDriveIO logDriveIO,
      Map<String, CanivoreIO> canivoreIOs,
      AlertMaker alerts) {
    this.real = real;
    this.systemIO = systemIO;
    this.logDriveIO = logDriveIO;
    canivoreIOs.forEach((label, io) -> canivores.add(new Canivore(label, io, alerts)));
    logDriveLow = alerts.make(AlertType.kWarning);
    logDriveNotUsb = alerts.make(AlertType.kError);
  }

  private static Map<String, CanivoreIO> realCanivores(CANBus... buses) {
    Map<String, CanivoreIO> ios = new LinkedHashMap<>();
    for (CANBus bus : buses) {
      ios.put(label(bus.getName()), new CanivoreIOReal(bus));
    }
    return ios;
  }

  /** The bus name as a log key: "*" (any CANivore) logs as "Any"; "" is the roboRIO's bus. */
  static String label(String busName) {
    if (busName.equals("*")) {
      return "Any";
    }
    if (busName.isEmpty()) {
      return "rio";
    }
    return busName.replace('/', '_');
  }

  /** Call once per loop from robotPeriodic. */
  public void periodic() {
    if (real && loopCount % READ_PERIOD_LOOPS == 0) {
      readHardware(loopCount == 0);
    }
    loopCount++;
    forEachInputs(Logger::processInputs);
    updateAlerts();
  }

  private void readHardware(boolean atBoot) {
    readSafely(() -> systemIO.updateInputs(systemInputs), why -> systemInputs.status = why);
    if (atBoot) {
      readSafely(() -> logDriveIO.updateInputs(logDriveInputs), why -> logDriveInputs.status = why);
    }
    for (Canivore canivore : canivores) {
      readSafely(() -> canivore.io.updateInputs(canivore.inputs), why -> canivore.inputs.status = why);
    }
  }

  /** A monitoring library must never stop the robot code, so a failed read is logged instead. */
  private static void readSafely(Runnable read, Consumer<String> logWhy) {
    try {
      read.run();
    } catch (RuntimeException e) {
      logWhy.accept("unavailable: " + e.getClass().getSimpleName());
    }
  }

  /** Every set of inputs and the key it's logged under. Tests use it to check the key list. */
  void forEachInputs(BiConsumer<String, LoggableInputs> log) {
    log.accept("Hindsight/System", systemInputs);
    log.accept("Hindsight/LogDrive", logDriveInputs);
    for (Canivore canivore : canivores) {
      log.accept("Hindsight/CANivore/" + canivore.label, canivore.inputs);
    }
  }

  private void updateAlerts() {
    boolean driveRead = logDriveInputs.status.equals("ok");
    logDriveLow.set(
        driveRead && logDriveInputs.onUsb && logDriveInputs.freeBytes < LOW_LOG_DRIVE_BYTES,
        String.format(
            "Log drive has %d MB free (want %d MB, about ten matches)",
            logDriveInputs.freeBytes / 1_000_000, LOW_LOG_DRIVE_BYTES / 1_000_000));
    logDriveNotUsb.set(
        driveRead && !logDriveInputs.onUsb,
        "Robot log isn't going to a USB stick: " + logDriveInputs.path + " is on the roboRIO");
    for (Canivore canivore : canivores) {
      canivore.updateAlerts();
    }
  }

  /** One CANivore: its inputs, its alerts, and what the alerts compare against. */
  private static final class Canivore {
    final String label;
    final CanivoreIO io;
    final CanivoreIOInputsAutoLogged inputs = new CanivoreIOInputsAutoLogged();
    final AlertOut busy;
    final AlertOut tooBusy;
    final AlertOut busErrors;
    final AlertOut errorCountersRising;
    int busOffCountAtStart = -1;
    int lastRec = 0;
    int lastTec = 0;
    int loopsSinceCountersRose = ERROR_COUNTERS_SHOWN_LOOPS + 1;

    Canivore(String label, CanivoreIO io, AlertMaker alerts) {
      this.label = label;
      this.io = io;
      busy = alerts.make(AlertType.kWarning);
      tooBusy = alerts.make(AlertType.kError);
      busErrors = alerts.make(AlertType.kError);
      errorCountersRising = alerts.make(AlertType.kWarning);
    }

    void updateAlerts() {
      boolean read = !inputs.status.equals("not read");
      boolean ok = inputs.status.equals("OK");
      double percent = inputs.utilizationPercent;
      String busyText = String.format("CANivore %s bus %.1f%% busy", label, percent);
      tooBusy.set(ok && percent > TOO_BUSY_PERCENT, busyText + " (CTRE: keep under 90%)");
      busy.set(
          ok && percent > BUSY_PERCENT && percent <= TOO_BUSY_PERCENT,
          busyText + " (warning above 80%)");

      // A restarted CANivore counts from 0 again, so start counting from there
      if (ok && (busOffCountAtStart < 0 || inputs.busOffCount < busOffCountAtStart)) {
        busOffCountAtStart = inputs.busOffCount;
      }
      int busOffs = busOffCountAtStart < 0 ? 0 : inputs.busOffCount - busOffCountAtStart;
      if (read && !ok) {
        busErrors.set(true, "CANivore " + label + " can't be read: " + inputs.status);
      } else {
        busErrors.set(
            busOffs > 0, "CANivore " + label + " bus turned off " + busOffs + " times since boot");
      }

      boolean rose = ok && (inputs.rec > lastRec || inputs.tec > lastTec);
      if (ok) {
        lastRec = inputs.rec;
        lastTec = inputs.tec;
      }
      if (rose) {
        loopsSinceCountersRose = 0;
      } else if (loopsSinceCountersRose <= ERROR_COUNTERS_SHOWN_LOOPS) {
        loopsSinceCountersRose++;
      }
      errorCountersRising.set(
          loopsSinceCountersRose <= ERROR_COUNTERS_SHOWN_LOOPS,
          String.format(
              "CANivore %s bus errors rising (receive %d, transmit %d)",
              label, inputs.rec, inputs.tec));
    }
  }
}
