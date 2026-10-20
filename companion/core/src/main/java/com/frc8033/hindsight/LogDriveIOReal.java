package com.frc8033.hindsight;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.Predicate;

/**
 * Finds the drive the log folder is on, and its free space. If the stick is missing, the folder doesn't
 * exist, so the nearest folder that does (usually "/") is what's reported: not on USB. A stick
 * pulled while its mount lingers is caught by its device file being gone.
 */
public class LogDriveIOReal implements LogDriveIO {
  private final String logDirectory;
  private final Path procMounts;
  private final Predicate<String> devicePresent;

  public LogDriveIOReal(String logDirectory) {
    this(logDirectory, Path.of("/proc/mounts"));
  }

  LogDriveIOReal(String logDirectory, Path procMounts) {
    this(logDirectory, procMounts, device -> Files.exists(Path.of(device)));
  }

  LogDriveIOReal(String logDirectory, Path procMounts, Predicate<String> devicePresent) {
    this.logDirectory = logDirectory;
    this.procMounts = procMounts;
    this.devicePresent = devicePresent;
  }

  @Override
  public void updateInputs(LogDriveIOInputs inputs) {
    inputs.path = logDirectory;
    File existing = nearestExisting(new File(logDirectory).getAbsoluteFile());
    if (existing == null) {
      inputs.status = "unavailable: no folder on the path exists";
      return;
    }
    try {
      inputs.resolvedPath = existing.getCanonicalPath();
    } catch (IOException e) {
      // Not following /U's link would read as the roboRIO's own storage: off the stick
      inputs.status = "unavailable: can't resolve " + existing;
      return;
    }
    inputs.freeBytes = existing.getUsableSpace();
    inputs.totalBytes = existing.getTotalSpace();

    String mounts;
    try {
      mounts = Files.readString(procMounts);
    } catch (IOException | RuntimeException e) {
      inputs.status = "unavailable: " + procMounts;
      return;
    }
    inputs.device = deviceFor(mounts, inputs.resolvedPath);
    inputs.onUsb = LogDriveIO.isUsb(inputs.device) && devicePresent.test(inputs.device);
    inputs.status = "ok";
  }

  private static File nearestExisting(File file) {
    while (file != null && !file.exists()) {
      file = file.getParentFile();
    }
    return file;
  }

  /**
   * The device of the mount point that holds the path: the longest mount point the path starts
   * with; of two mounts at one point, the later one is on top. /proc/mounts lines are "device
   * mountpoint type options 0 0", with spaces written "\040".
   */
  static String deviceFor(String procMounts, String path) {
    String best = "";
    int bestLength = -1;
    for (String line : procMounts.split("\n")) {
      String[] fields = line.trim().split("\\s+");
      if (fields.length < 2) {
        continue;
      }
      String mountPoint = fields[1].replace("\\040", " ");
      boolean holdsPath =
          mountPoint.equals("/") || path.equals(mountPoint) || path.startsWith(mountPoint + "/");
      if (holdsPath && mountPoint.length() >= bestLength) {
        best = fields[0];
        bestLength = mountPoint.length();
      }
    }
    return best;
  }
}
