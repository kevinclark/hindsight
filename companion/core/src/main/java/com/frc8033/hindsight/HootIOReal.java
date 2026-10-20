package com.frc8033.hindsight;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.function.LongSupplier;

/**
 * Looks for .hoot files in the log folders, and in their date-time subfolders (Phoenix puts each
 * session's files in one). Read-only: it never starts, stops or moves Phoenix's logging.
 */
public class HootIOReal implements HootIO {
  /** A file written within this long counts as being recorded now. A guess: check on a robot. */
  static final double RECORDING_WITHIN_SECONDS = 5.0;

  /** Where Phoenix writes on a roboRIO: the USB stick if there is one, else its own storage. Assumed. */
  static final List<String> DEFAULT_FOLDERS = List.of("/U/logs", "/home/lvuser/logs");

  private final List<File> folders = new ArrayList<>();
  private final LongSupplier nowMillis;

  public HootIOReal() {
    this(DEFAULT_FOLDERS, System::currentTimeMillis);
  }

  HootIOReal(List<String> folders, LongSupplier nowMillis) {
    for (String folder : folders) {
      this.folders.add(new File(folder));
    }
    this.nowMillis = nowMillis;
  }

  @Override
  public void updateInputs(HootIOInputs inputs) {
    List<File> hootFiles = new ArrayList<>();
    boolean anyFolder = false;
    for (File folder : folders) {
      if (folder.isDirectory()) {
        anyFolder = true;
        collectHootFiles(folder, 2, hootFiles);
      }
    }
    long now = nowMillis.getAsLong();
    File newest = null;
    int writing = 0;
    for (File file : hootFiles) {
      if (newest == null || file.lastModified() > newest.lastModified()) {
        newest = file;
      }
      if (secondsSince(file, now) <= RECORDING_WITHIN_SECONDS) {
        writing++;
      }
    }

    inputs.filesWriting = writing;
    inputs.recording = writing > 0;
    inputs.newestFile = newest == null ? "" : newest.getPath();
    inputs.newestSizeBytes = newest == null ? 0 : newest.length();
    inputs.secondsSinceWritten = newest == null ? 0.0 : secondsSince(newest, now);
    if (!anyFolder) {
      inputs.status = "unavailable: no log folder";
    } else if (newest == null) {
      inputs.status = "no hoot files";
    } else {
      inputs.status = "ok";
    }
  }

  private static double secondsSince(File file, long nowMillis) {
    return Math.max(0, nowMillis - file.lastModified()) / 1000.0;
  }

  /** Adds the .hoot files in a folder and its subfolders, down to the given depth. */
  private static void collectHootFiles(File folder, int depth, List<File> found) {
    File[] children = folder.listFiles();
    if (children == null) {
      return;
    }
    for (File child : children) {
      if (child.isFile() && child.getName().endsWith(".hoot")) {
        found.add(child);
      } else if (child.isDirectory() && depth > 0) {
        collectHootFiles(child, depth - 1, found);
      }
    }
  }
}
