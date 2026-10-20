package com.frc8033.hindsight;

import org.littletonrobotics.junction.AutoLog;

/** The drive AdvantageKit writes its log to, read once at boot. */
public interface LogDriveIO {
  @AutoLog
  public static class LogDriveIOInputs {
    /** The log folder the robot code gave AdvantageKit, e.g. "/U". */
    public String path = "";

    /** Where that folder really is, after following links (/U is a link to the USB stick). */
    public String resolvedPath = "";

    /** The device it's mounted from, from /proc/mounts: "/dev/sda1" for a USB stick. */
    public String device = "";

    public boolean onUsb = false;
    public long freeBytes = 0;
    public long totalBytes = 0;

    /** "ok", "not read" (simulation, or before boot), or "unavailable: ..." with why. */
    public String status = "not read";
  }

  /** Does nothing by default, so sim and replay use the logged values. */
  public default void updateInputs(LogDriveIOInputs inputs) {}
}
