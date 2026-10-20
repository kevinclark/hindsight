package com.frc8033.hindsight;

import com.ctre.phoenix6.StatusCode;
import com.ctre.phoenix6.StatusSignal;
import com.ctre.phoenix6.hardware.CANcoder;
import com.ctre.phoenix6.hardware.CANdi;
import com.ctre.phoenix6.hardware.CANdle;
import com.ctre.phoenix6.hardware.CANrange;
import com.ctre.phoenix6.hardware.Pigeon2;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.hardware.TalonFXS;
import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Reads a device's health from its own copies of the signals, so the team's signal objects are
 * never refreshed or changed. Getting a signal with refresh=false and cloning it sends nothing on
 * CAN and sets no rate: these signals arrive at 4 Hz by default.
 */
public class DeviceIOReal implements DeviceIO {
  /** Phoenix's own test for "connected" (ParentDevice.isConnected()). */
  private static final double MAX_AGE_SECONDS = 0.5;

  private final StatusSignal<Integer> version;
  private final StatusSignal<Integer> faultField;
  private final StatusSignal<Integer> stickyFaultField;
  private final StatusSignal<Boolean> proLicensed;
  private final BooleanSupplier resetOccurred;
  private boolean wasConnected = false;

  DeviceIOReal(
      StatusSignal<Integer> version,
      StatusSignal<Integer> faultField,
      StatusSignal<Integer> stickyFaultField,
      StatusSignal<Boolean> proLicensed,
      BooleanSupplier resetOccurred) {
    this.version = version.clone();
    this.faultField = faultField.clone();
    this.stickyFaultField = stickyFaultField.clone();
    this.proLicensed = proLicensed.clone();
    // A checker with its own flag: the team's hasResetOccurred() still works
    this.resetOccurred = resetOccurred;
  }

  static DeviceIOReal of(TalonFX d) {
    return new DeviceIOReal(d.getVersion(false), d.getFaultField(false),
        d.getStickyFaultField(false), d.getIsProLicensed(false), d.getResetOccurredChecker());
  }

  static DeviceIOReal of(TalonFXS d) {
    return new DeviceIOReal(d.getVersion(false), d.getFaultField(false),
        d.getStickyFaultField(false), d.getIsProLicensed(false), d.getResetOccurredChecker());
  }

  static DeviceIOReal of(CANcoder d) {
    return new DeviceIOReal(d.getVersion(false), d.getFaultField(false),
        d.getStickyFaultField(false), d.getIsProLicensed(false), d.getResetOccurredChecker());
  }

  static DeviceIOReal of(Pigeon2 d) {
    return new DeviceIOReal(d.getVersion(false), d.getFaultField(false),
        d.getStickyFaultField(false), d.getIsProLicensed(false), d.getResetOccurredChecker());
  }

  static DeviceIOReal of(CANdi d) {
    return new DeviceIOReal(d.getVersion(false), d.getFaultField(false),
        d.getStickyFaultField(false), d.getIsProLicensed(false), d.getResetOccurredChecker());
  }

  static DeviceIOReal of(CANrange d) {
    return new DeviceIOReal(d.getVersion(false), d.getFaultField(false),
        d.getStickyFaultField(false), d.getIsProLicensed(false), d.getResetOccurredChecker());
  }

  static DeviceIOReal of(CANdle d) {
    return new DeviceIOReal(d.getVersion(false), d.getFaultField(false),
        d.getStickyFaultField(false), d.getIsProLicensed(false), d.getResetOccurredChecker());
  }

  @Override
  public void updateInputs(DeviceIOInputs inputs) {
    // refresh(false): a device that isn't answering is logged here, not printed to the driver
    // station console every second (refreshAll prints an error for each missing signal)
    StatusCode code = StatusCode.OK;
    for (StatusSignal<?> signal : List.of(version, faultField, stickyFaultField, proLicensed)) {
      StatusCode signalCode = signal.refresh(false).getStatus();
      if (code.isOK() && !signalCode.isOK()) {
        code = signalCode;
      }
    }
    inputs.status = code.name();
    inputs.connected = code.isOK() && version.getTimestamp().getLatency() <= MAX_AGE_SECONDS;
    inputs.version = orZero(version.getValue());
    inputs.faultField = orZero(faultField.getValue());
    inputs.stickyFaultField = orZero(stickyFaultField.getValue());
    inputs.proLicensed = Boolean.TRUE.equals(proLicensed.getValue());

    // Phoenix's reset flag also turns up with the device's first answer after start-up, so only a
    // flag seen while the device was already answering counts as a reboot. A reboot longer than a
    // second shows as "not answering" first.
    boolean reset = resetOccurred.getAsBoolean();
    if (wasConnected && reset) {
      inputs.resets++;
    }
    wasConnected = inputs.connected;
  }

  private static int orZero(Integer value) {
    return value == null ? 0 : value;
  }
}
