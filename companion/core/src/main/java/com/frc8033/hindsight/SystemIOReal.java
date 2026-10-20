package com.frc8033.hindsight;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads CPU and memory from Linux's /proc files, and the heap from the Java runtime. On a computer
 * without /proc (a Mac, Windows) it logs "unavailable" and never throws.
 */
public class SystemIOReal implements SystemIO {
  /** CPU time counters from the first line of /proc/stat, in clock ticks. */
  record CpuTimes(long total, long idle) {}

  /** MemAvailable and MemTotal from /proc/meminfo, in bytes; -1 when missing. */
  record Memory(long availableBytes, long totalBytes) {}

  private final Path procStat;
  private final Path procMeminfo;
  private CpuTimes lastCpu = null;

  public SystemIOReal() {
    this(Path.of("/proc/stat"), Path.of("/proc/meminfo"));
  }

  SystemIOReal(Path procStat, Path procMeminfo) {
    this.procStat = procStat;
    this.procMeminfo = procMeminfo;
  }

  @Override
  public void updateInputs(SystemIOInputs inputs) {
    List<String> unreadable = new ArrayList<>();
    boolean firstCpuSample = false;

    CpuTimes cpu = parseCpuTimes(readOrNull(procStat));
    if (cpu == null) {
      unreadable.add(procStat.toString());
      inputs.cpuPercent = 0.0;
      lastCpu = null;
    } else if (lastCpu == null) {
      firstCpuSample = true;
      inputs.cpuPercent = 0.0;
      lastCpu = cpu;
    } else {
      inputs.cpuPercent = cpuPercent(lastCpu, cpu);
      lastCpu = cpu;
    }

    Memory memory = parseMemory(readOrNull(procMeminfo));
    if (memory == null) {
      unreadable.add(procMeminfo.toString());
      inputs.memAvailableBytes = 0;
      inputs.memTotalBytes = 0;
    } else {
      inputs.memAvailableBytes = memory.availableBytes();
      inputs.memTotalBytes = memory.totalBytes();
    }

    Runtime runtime = Runtime.getRuntime();
    inputs.heapUsedBytes = runtime.totalMemory() - runtime.freeMemory();
    inputs.heapMaxBytes = runtime.maxMemory();

    if (!unreadable.isEmpty()) {
      inputs.status = "unavailable: " + String.join(", ", unreadable);
    } else if (firstCpuSample) {
      inputs.status = "first CPU sample";
    } else {
      inputs.status = "ok";
    }
  }

  private static String readOrNull(Path file) {
    try {
      return Files.readString(file);
    } catch (IOException | RuntimeException e) {
      return null;
    }
  }

  /**
   * The "cpu" line adds up every core: user nice system idle iowait irq softirq steal (then guest
   * time, already counted in user). Waiting on the disk (iowait) counts as idle.
   */
  static CpuTimes parseCpuTimes(String procStat) {
    if (procStat == null) {
      return null;
    }
    for (String line : procStat.split("\n")) {
      String[] fields = line.trim().split("\\s+");
      if (!fields[0].equals("cpu") || fields.length < 6) {
        continue;
      }
      try {
        long total = 0;
        for (int i = 1; i < Math.min(fields.length, 9); i++) {
          total += Long.parseLong(fields[i]);
        }
        long idle = Long.parseLong(fields[4]) + Long.parseLong(fields[5]);
        return new CpuTimes(total, idle);
      } catch (NumberFormatException e) {
        return null;
      }
    }
    return null;
  }

  /** The busy share of the time between two reads, 0 to 100; 0 if no time passed. */
  static double cpuPercent(CpuTimes before, CpuTimes after) {
    long total = after.total() - before.total();
    long idle = after.idle() - before.idle();
    if (total <= 0) {
      return 0.0;
    }
    return Math.max(0.0, Math.min(100.0, 100.0 * (total - idle) / total));
  }

  /** Lines look like "MemAvailable:   123456 kB". Null unless both values are there. */
  static Memory parseMemory(String meminfo) {
    if (meminfo == null) {
      return null;
    }
    long available = -1;
    long total = -1;
    for (String line : meminfo.split("\n")) {
      String[] fields = line.trim().split("\\s+");
      if (fields.length < 2) {
        continue;
      }
      try {
        long bytes = Long.parseLong(fields[1]) * (fields.length > 2 && fields[2].equals("kB") ? 1024 : 1);
        if (fields[0].equals("MemAvailable:")) {
          available = bytes;
        } else if (fields[0].equals("MemTotal:")) {
          total = bytes;
        }
      } catch (NumberFormatException e) {
        // not a number line; skip it
      }
    }
    return available >= 0 && total >= 0 ? new Memory(available, total) : null;
  }
}
