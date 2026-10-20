package com.frc8033.hindsight;

import org.littletonrobotics.junction.AutoLog;

/** The drive AdvantageKit writes its log to, read once a second. */
public interface LogDriveIO {
  @AutoLog
  public static class LogDriveIOInputs {
    /** The log folder the robot code gave AdvantageKit, e.g. "/U". */
    public String path = "";

    /** Where that folder really is, after following links (/U is a link to the USB stick). */
    public String resolvedPath = "";

    /** The device it's mounted from, from /proc/mounts: "/dev/sda1" for a USB stick. */
    public String device = "";

    /**
     * The folder is on a USB stick that's still there. As logged, it's false from the first read that
     * found it off the stick: AdvantageKit opens its log file once, so a stick that was out has lost
     * the log until the code restarts, even after it goes back in (HindsightCompanion keeps it false).
     */
    public boolean onUsb = false;

    public long freeBytes = 0;
    public long totalBytes = 0;

    /** "ok", "not read" (simulation, or before the first read), or "unavailable: ..." with why. */
    public String status = "not read";
  }

  /** Does nothing by default, so sim and replay use the logged values. */
  public default void updateInputs(LogDriveIOInputs inputs) {}

  /** A USB stick on a roboRIO is a SCSI disk ("/dev/sd..."); the roboRIO's own storage is not. */
  static boolean isUsb(String device) {
    return device.startsWith("/dev/sd");
  }
}
