package com.frc8033.hindsight.battery;

import edu.wpi.first.wpilibj.Alert;
import edu.wpi.first.wpilibj.Alert.AlertType;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.RobotBase;
import org.littletonrobotics.junction.Logger;
import org.littletonrobotics.junction.networktables.LoggedNetworkString;

/**
 * Records which battery is in the robot, so log analysis can follow each battery across matches.
 *
 * <p>The ID comes from the battery's fuel gauge: its nickname, or "BFG-" plus its serial number if
 * no nickname is set. If the gauge drops out, the last ID it gave since boot is kept (a battery
 * swap always reboots the roboRIO). If no gauge has been seen since boot, type the label written on
 * the battery (e.g. "B07") into the BatteryId field on the dashboard. The dashboard can send back
 * the old label after a reboot, so retype it after every battery swap; the robot also clears the
 * field at the end of each FMS match.
 *
 * <p>Logged every loop as Battery/Id and Battery/IdSource ("gauge", "gauge-cached", "dashboard" or
 * "none").
 */
public class BatteryTracker {
  /** The gauge is read once a second: its values change slowly. */
  private static final int GAUGE_READ_PERIOD_LOOPS = 50;

  // The keys Hindsight reads; companion/keys.json lists them and a test checks they match
  static final String GAUGE_KEY = "BatteryGauge";
  static final String ID_KEY = "Battery/Id";
  static final String ID_SOURCE_KEY = "Battery/IdSource";
  static final String TYPED_ID_KEY = "/SmartDashboard/BatteryId";

  record Resolved(String id, String source) {}

  private final BatteryGaugeIO gaugeIO;
  private final BatteryGaugeIOInputsAutoLogged gaugeInputs = new BatteryGaugeIOInputsAutoLogged();
  private final LoggedNetworkString batteryIdEntry =
      new LoggedNetworkString(TYPED_ID_KEY, "");
  private int loopCount = 0;
  private String lastGaugeId = "";
  private boolean teleopEnabledInMatch = false;

  private final Alert notSetAlert =
      new Alert(
          "Battery ID unknown: no fuel gauge seen and BatteryId not typed", AlertType.kWarning);
  private final Alert gaugeDisconnectedAlert =
      new Alert("Battery fuel gauge not connected or not reporting", AlertType.kWarning);
  private final Alert typedIdAlert = new Alert("", AlertType.kInfo);
  private final Alert mismatchAlert = new Alert("", AlertType.kWarning);

  public BatteryTracker(BatteryGaugeIO gaugeIO) {
    this.gaugeIO = gaugeIO;
  }

  /** Call once per loop from robotPeriodic. */
  public void periodic() {
    if (loopCount++ % GAUGE_READ_PERIOD_LOOPS == 0) {
      gaugeIO.updateInputs(gaugeInputs);
    }
    Logger.processInputs(GAUGE_KEY, gaugeInputs);

    String liveGaugeId = gaugeId(gaugeInputs.valid, gaugeInputs.nickname, gaugeInputs.serialNumber);
    if (!liveGaugeId.isEmpty()) {
      lastGaugeId = liveGaugeId;
    }
    String typedId = normalize(batteryIdEntry.get());
    Resolved resolved = resolve(liveGaugeId, lastGaugeId, typedId);

    Logger.recordOutput(ID_KEY, resolved.id());
    Logger.recordOutput(ID_SOURCE_KEY, resolved.source());

    notSetAlert.set(resolved.id().isEmpty());
    gaugeDisconnectedAlert.set(RobotBase.isReal() && !gaugeInputs.valid);
    boolean usingTypedId = resolved.source().equals("dashboard");
    if (usingTypedId) {
      typedIdAlert.setText(
          "Battery ID " + typedId + " typed on the dashboard: retype after a swap");
    }
    typedIdAlert.set(usingTypedId);
    boolean mismatch = !lastGaugeId.isEmpty() && !typedId.isEmpty() && !lastGaugeId.equals(typedId);
    if (mismatch) {
      mismatchAlert.setText(
          "Typed BatteryId " + typedId + " doesn't match the gauge's " + lastGaugeId);
    }
    mismatchAlert.set(mismatch);

    clearTypedIdAfterMatch();
  }

  /**
   * Clears the typed ID once teleop of an FMS match ends, so it can't carry into the next match.
   */
  private void clearTypedIdAfterMatch() {
    if (DriverStation.isFMSAttached() && DriverStation.isTeleopEnabled()) {
      teleopEnabledInMatch = true;
    } else if (teleopEnabledInMatch && DriverStation.isDisabled()) {
      batteryIdEntry.set("");
      teleopEnabledInMatch = false;
    }
  }

  /** Picks the ID: live gauge, then the gauge's last ID since boot, then the typed label. */
  static Resolved resolve(String liveGaugeId, String lastGaugeId, String typedId) {
    if (!liveGaugeId.isEmpty()) {
      return new Resolved(liveGaugeId, "gauge");
    }
    if (!lastGaugeId.isEmpty()) {
      return new Resolved(lastGaugeId, "gauge-cached");
    }
    if (!typedId.isEmpty()) {
      return new Resolved(typedId, "dashboard");
    }
    return new Resolved("", "none");
  }

  /** The gauge's nickname, else "BFG-" plus its serial number, else "" if there is no gauge. */
  static String gaugeId(boolean valid, String nickname, long serialNumber) {
    if (!valid) {
      return "";
    }
    String name = normalize(nickname);
    if (!name.isEmpty()) {
      return name;
    }
    return serialNumber != 0 ? "BFG-" + serialNumber : "";
  }

  /** Trims and upper-cases a label so "b07 " and "B07" log the same. */
  static String normalize(String raw) {
    return raw == null ? "" : raw.trim().toUpperCase();
  }
}
