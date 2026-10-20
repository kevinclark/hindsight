package com.frc8033.hindsight;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Finds the drive the log folder is on, and its free space. A USB stick on a roboRIO is a SCSI disk
 * ("/dev/sd..."); the roboRIO's own storage is not. If the stick is missing, the folder doesn't
 * exist, so the nearest folder that does (usually "/") is what's reported: not on USB.
 */
public class LogDriveIOReal implements LogDriveIO {
  private final String logDirectory;
  private final Path procMounts;

  public LogDriveIOReal(String logDirectory) {
    this(logDirectory, Path.of("/proc/mounts"));
  }

  LogDriveIOReal(String logDirectory, Path procMounts) {
    this.logDirectory = logDirectory;
    this.procMounts = procMounts;
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
      inputs.resolvedPath = existing.getAbsolutePath();
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
    inputs.onUsb = isUsb(inputs.device);
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

  static boolean isUsb(String device) {
    return device.startsWith("/dev/sd");
  }
}
