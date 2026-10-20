package com.frc8033.hindsight;

import org.littletonrobotics.junction.AutoLog;

/** The roboRIO's CPU and memory, and the robot program's Java heap. */
public interface SystemIO {
  @AutoLog
  public static class SystemIOInputs {
    /** Busy share of all CPU time since the last read, 0 to 100. */
    public double cpuPercent = 0.0;

    /** Memory the kernel could hand to programs without swapping (/proc/meminfo MemAvailable). */
    public long memAvailableBytes = 0;

    public long memTotalBytes = 0;
    public long heapUsedBytes = 0;
    public long heapMaxBytes = 0;

    /**
     * "ok" when every value above was read. Otherwise says why not: "not read" (simulation, or
     * before the first read), "first CPU sample" (CPU needs two reads), or "unavailable: ..."
     * naming the file that couldn't be read.
     */
    public String status = "not read";
  }

  /** Does nothing by default, so sim and replay use the logged values. */
  public default void updateInputs(SystemIOInputs inputs) {}
}
