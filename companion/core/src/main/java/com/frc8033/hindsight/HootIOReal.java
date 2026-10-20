package com.frc8033.hindsight;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.function.LongSupplier;

/**
 * Looks for .hoot files in the log folders, and in the newest of their subfolders (Phoenix puts
 * each session's files in a date-time folder, so only the newest can be recording). Read-only: it
 * never starts, stops or moves Phoenix's logging.
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
        collectHootFiles(folder, hootFiles);
        File newestSubfolder = newestSubfolder(folder);
        if (newestSubfolder != null) {
          collectHootFiles(newestSubfolder, hootFiles);
        }
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

  /** Adds the .hoot files directly in a folder. The name is checked first: it costs no disk read. */
  private static void collectHootFiles(File folder, List<File> found) {
    File[] hootFiles = folder.listFiles((dir, name) -> name.endsWith(".hoot"));
    if (hootFiles != null) {
      found.addAll(List.of(hootFiles));
    }
  }

  private static File newestSubfolder(File folder) {
    File[] subfolders = folder.listFiles(File::isDirectory);
    File newest = null;
    for (File subfolder : subfolders == null ? new File[0] : subfolders) {
      if (newest == null || subfolder.lastModified() > newest.lastModified()) {
        newest = subfolder;
      }
    }
    return newest;
  }
}
