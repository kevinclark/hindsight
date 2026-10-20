package com.frc8033.hindsight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.frc8033.hindsight.HootIO.HootIOInputs;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class HootIORealTest {
  static final long NOW = 1_800_000_000_000L;

  static File hoot(Path folder, String name, int bytes, long secondsAgo) throws IOException {
    Files.createDirectories(folder);
    File file = Files.write(folder.resolve(name), new byte[bytes]).toFile();
    assertTrue(file.setLastModified(NOW - secondsAgo * 1000));
    return file;
  }

  HootIOInputs read(Path... folders) {
    HootIOInputs inputs = new HootIOInputs();
    List<String> paths = java.util.Arrays.stream(folders).map(Path::toString).toList();
    new HootIOReal(paths, () -> NOW).updateInputs(inputs);
    return inputs;
  }

  @Test
  void filesWrittenInTheLastFewSecondsMeanRecording(@TempDir Path logs) throws IOException {
    Path session = logs.resolve("2026-10-20_14-02-11");
    hoot(session, "rio_2026-10-20_14-02-11.hoot", 1000, 1);
    File newest = hoot(session, "canivore_2026-10-20_14-02-11.hoot", 5000, 0);
    hoot(logs.resolve("2026-10-19_09-00-00"), "old.hoot", 9000, 86_400);
    assertTrue(logs.resolve("2026-10-19_09-00-00").toFile().setLastModified(NOW - 86_400_000));
    assertTrue(session.toFile().setLastModified(NOW));

    HootIOInputs inputs = read(logs);
    assertEquals("ok", inputs.status);
    assertTrue(inputs.recording);
    assertEquals(2, inputs.filesWriting);
    assertEquals(newest.getPath(), inputs.newestFile);
    assertEquals(5000, inputs.newestSizeBytes);
    assertEquals(0.0, inputs.secondsSinceWritten);
  }

  @Test
  void oldFilesOnlyMeanNotRecording(@TempDir Path logs) throws IOException {
    hoot(logs.resolve("2026-10-19_09-00-00"), "rio.hoot", 100, 600);
    HootIOInputs inputs = read(logs);
    assertFalse(inputs.recording);
    assertEquals(600.0, inputs.secondsSinceWritten);
  }

  @Test
  void onlyTheNewestSessionFolderIsSearched(@TempDir Path logs) throws IOException {
    hoot(logs.resolve("old-session"), "rio.hoot", 100, 0);
    assertTrue(logs.resolve("old-session").toFile().setLastModified(NOW - 3_600_000));
    Files.createDirectories(logs.resolve("new-session"));
    assertTrue(logs.resolve("new-session").toFile().setLastModified(NOW));
    assertEquals("no hoot files", read(logs).status);
  }

  @Test
  void otherFilesAndMissingFoldersAreReported(@TempDir Path logs) throws IOException {
    hoot(logs, "match.wpilog", 100, 0);
    assertEquals("no hoot files", read(logs).status);
    assertEquals("unavailable: no log folder", read(logs.resolve("missing")).status);
  }
}
