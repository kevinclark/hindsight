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
 * is busy or has errors, when the log drive is low or isn't the USB stick, and when a device given
 * to {@link HindsightDevices#watch} isn't answering, rebooted, has a sticky fault, or runs different
 * firmware from others of its model. It also logs whether Phoenix's hoot recording is on.
 */
public class HindsightCompanion {
  /** Read once a second: getStatus() can block for up to 1 ms, and these values change slowly. */
  static final int READ_PERIOD_LOOPS = 50;

  /** CTRE: keep a CANivore under 90 %; its own API example warns at 80 %. */
  static final double BUSY_PERCENT = 80.0;

  static final double TOO_BUSY_PERCENT = 90.0;

  /** Ten matches at about 55 MB each (measured on our 2026 logs), so an event day fits. */
  static final long LOW_LOG_DRIVE_BYTES = 600_000_000L;

  /** Devices get two reads before one counts as not answering: their first frames may still be on their way. */
  static final int DEVICE_GRACE_LOOPS = 2 * READ_PERIOD_LOOPS;

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
  private final HootIO hootIO;
  private final HootIOInputsAutoLogged hootInputs = new HootIOInputsAutoLogged();
  private final List<Canivore> canivores = new ArrayList<>();
  private final AlertOut logDriveLow;
  private final AlertOut logDriveNotUsb;
  private final AlertOut devicesNotAnswering;
  private final AlertOut devicesRebooted;
  private final AlertOut devicesWithStickyFaults;
  private final AlertOut firmwareMismatch;
  private boolean stickWasOut = false;
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
        new HootIOReal(),
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
      HootIO hootIO,
      Map<String, CanivoreIO> canivoreIOs,
      AlertMaker alerts) {
    this.real = real;
    this.systemIO = systemIO;
    this.logDriveIO = logDriveIO;
    this.hootIO = hootIO;
    canivoreIOs.forEach((label, io) -> canivores.add(new Canivore(label, io, alerts)));
    logDriveLow = alerts.make(AlertType.kWarning);
    logDriveNotUsb = alerts.make(AlertType.kError);
    devicesNotAnswering = alerts.make(AlertType.kError);
    devicesRebooted = alerts.make(AlertType.kWarning);
    devicesWithStickyFaults = alerts.make(AlertType.kWarning);
    firmwareMismatch = alerts.make(AlertType.kWarning);
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
      readHardware();
    }
    loopCount++;
    forEachInputs(Logger::processInputs);
    updateAlerts();
  }

  private void readHardware() {
    readSafely(() -> systemIO.updateInputs(systemInputs), why -> systemInputs.status = why);
    readSafely(() -> logDriveIO.updateInputs(logDriveInputs), why -> logDriveInputs.status = why);
    // AdvantageKit opens its log file once, so a stick that was out at any read has lost the log
    // until the code restarts, even after it goes back in
    if (logDriveInputs.status.equals("ok") && !logDriveInputs.onUsb) {
      stickWasOut = true;
    }
    logDriveInputs.onUsb &= !stickWasOut;
    for (Canivore canivore : canivores) {
      readSafely(() -> canivore.io.updateInputs(canivore.inputs), why -> canivore.inputs.status = why);
    }
    readSafely(() -> hootIO.updateInputs(hootInputs), why -> hootInputs.status = why);
    for (HindsightDevices.Watched device : HindsightDevices.all()) {
      readSafely(() -> device.io().updateInputs(device.inputs()), why -> device.inputs().status = why);
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
    log.accept("Hindsight/Hoot", hootInputs);
    for (HindsightDevices.Watched device : HindsightDevices.all()) {
      log.accept("Hindsight/Devices/" + device.key(), device.inputs());
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
        LogDriveIO.isUsb(logDriveInputs.device)
            ? "Robot log isn't going to the USB stick: it wasn't in the whole time since the robot"
                + " code started (restart the robot code)"
            : "Robot log isn't going to a USB stick: "
                + logDriveInputs.path
                + " is on the roboRIO, or nowhere");
    for (Canivore canivore : canivores) {
      canivore.updateAlerts();
    }
    updateDeviceAlerts(HindsightDevices.all());
  }

  /** One alert per kind, naming every device it applies to. Only devices read at least once count. */
  private void updateDeviceAlerts(List<HindsightDevices.Watched> devices) {
    List<String> notAnswering = new ArrayList<>();
    List<String> rebooted = new ArrayList<>();
    List<String> stickyFaults = new ArrayList<>();
    Map<String, Integer> firmwareByModel = new LinkedHashMap<>();
    List<String> mismatchedModels = new ArrayList<>();
    for (HindsightDevices.Watched device : devices) {
      DeviceIOInputsAutoLogged in = device.inputs();
      if (in.status.equals("not read")) {
        continue;
      }
      if (!in.connected) {
        if (loopCount > DEVICE_GRACE_LOOPS) {
          notAnswering.add(device.name());
        }
        continue;
      }
      if (in.resets > 0) {
        rebooted.add(device.name() + " (" + in.resets + "x)");
      }
      if (in.stickyFaultField != 0) {
        stickyFaults.add(device.name());
      }
      String model = device.key().split("/")[1];
      Integer firstVersion = firmwareByModel.putIfAbsent(model, in.version);
      if (firstVersion != null && firstVersion != in.version && !mismatchedModels.contains(model)) {
        mismatchedModels.add(model);
      }
    }
    show(devicesNotAnswering, notAnswering,
        "Not answering (or its status signals are turned off): ");
    show(devicesRebooted, rebooted, "Rebooted while the code ran: ");
    show(devicesWithStickyFaults, stickyFaults, "Sticky faults set (see Tuner X, clear after the log is pulled): ");
    show(firmwareMismatch, mismatchedModels, "Different firmware on devices of one model: ");
  }

  private static void show(AlertOut alert, List<String> names, String text) {
    alert.set(!names.isEmpty(), names.isEmpty() ? "" : text + String.join(", ", names));
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
