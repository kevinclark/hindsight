package com.frc8033.hindsight;

import org.littletonrobotics.junction.AutoLog;

/**
 * Whether Phoenix's hoot recording is on. Phoenix has no call that says so, so it's worked out
 * from the files: a .hoot file written in the last few seconds means it's recording.
 */
public interface HootIO {
  @AutoLog
  public static class HootIOInputs {
    public boolean recording = false;

    /** .hoot files written in the last few seconds (Phoenix writes one per CAN bus). */
    public int filesWriting = 0;

    public String newestFile = "";
    public long newestSizeBytes = 0;
    public double secondsSinceWritten = 0.0;

    /** "ok", "no hoot files", "not read", or "unavailable: ..." with why. */
    public String status = "not read";
  }

  /** Does nothing by default, so sim and replay use the logged values. */
  public default void updateInputs(HootIOInputs inputs) {}
}
