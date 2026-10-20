package com.frc8033.hindsight;

import org.littletonrobotics.junction.AutoLog;

/** One CTRE device's health: is it answering, its firmware, its faults, and has it rebooted. */
public interface DeviceIO {
  @AutoLog
  public static class DeviceIOInputs {
    /** Answered within the last half second. */
    public boolean connected = false;

    /** Firmware version, as Phoenix packs it: major, minor, bugfix and build, one byte each. */
    public int version = 0;

    /** Every live fault, one bit each (the bits differ by model). */
    public int faultField = 0;

    /** Every fault that has happened since someone last cleared them, one bit each. */
    public int stickyFaultField = 0;

    public boolean proLicensed = false;

    /** Times the device rebooted while this robot code was running. */
    public int resets = 0;

    /** Phoenix's status code for the read: "OK", or why the signals couldn't be read. */
    public String status = "not read";
  }

  /** Does nothing by default, so sim and replay use the logged values. */
  public default void updateInputs(DeviceIOInputs inputs) {}
}
