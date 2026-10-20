package com.frc8033.hindsight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.frc8033.hindsight.LogDriveIO.LogDriveIOInputs;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LogDriveIORealTest {
  private static final String MOUNTS = Fixtures.proc("mounts");

  @Test
  void theLongestMountPointHoldingThePathWins() {
    assertEquals("/dev/sda1", LogDriveIOReal.deviceFor(MOUNTS, "/media/sda1"));
    assertEquals("/dev/sda1", LogDriveIOReal.deviceFor(MOUNTS, "/media/sda1/logs"));
    assertEquals("ubi0:rootfs", LogDriveIOReal.deviceFor(MOUNTS, "/home/lvuser/logs"));
    assertEquals("ubi0:rootfs", LogDriveIOReal.deviceFor(MOUNTS, "/media/sda10"));
    assertEquals("/dev/sdb1", LogDriveIOReal.deviceFor(MOUNTS, "/media/my stick/logs"));
    // Two mounts at one point: the later one is on top
    assertEquals("ubi0:rootfs", LogDriveIOReal.deviceFor("rootfs / rootfs rw 0 0\nubi0:rootfs / ubifs rw 0 0\n", "/home"));
  }

  @Test
  void onlyScsiDisksAreUsb() {
    assertTrue(LogDriveIO.isUsb("/dev/sda1"));
    assertFalse(LogDriveIO.isUsb("ubi0:rootfs"));
    assertFalse(LogDriveIO.isUsb("/dev/mmcblk0p1"));
    assertFalse(LogDriveIO.isUsb(""));
  }

  @Test
  void aMissingStickReportsTheFolderAboveItNotOnUsb(@TempDir Path dir) throws IOException {
    Path mounts = dir.resolve("mounts");
    Files.writeString(mounts, "ubi0:rootfs / ubifs rw 0 0\n");
    LogDriveIOInputs inputs = new LogDriveIOInputs();
    new LogDriveIOReal(dir.resolve("U/logs").toString(), mounts).updateInputs(inputs);
    assertEquals("ok", inputs.status);
    assertEquals(dir.resolve("U/logs").toString(), inputs.path);
    assertEquals(dir.toFile().getCanonicalPath(), inputs.resolvedPath);
    assertEquals("ubi0:rootfs", inputs.device);
    assertFalse(inputs.onUsb);
    assertTrue(inputs.freeBytes > 0 && inputs.totalBytes >= inputs.freeBytes);
  }

  @Test
  void eachReadSaysWhereTheFolderIsNow(@TempDir Path dir) throws IOException {
    Path stick = Files.createDirectories(dir.resolve("media/sda1/logs")).getParent();
    Path mounts = dir.resolve("mounts");
    String stickIn =
        "ubi0:rootfs / ubifs rw 0 0\n/dev/sda1 " + stick.toRealPath() + " vfat rw 0 0\n";
    Set<String> devices = new HashSet<>(Set.of("/dev/sda1"));
    LogDriveIOReal io =
        new LogDriveIOReal(stick.resolve("logs").toString(), mounts, devices::contains);
    LogDriveIOInputs inputs = new LogDriveIOInputs();

    Files.writeString(mounts, stickIn);
    io.updateInputs(inputs);
    assertEquals("/dev/sda1", inputs.device);
    assertTrue(inputs.onUsb);

    // Pulled: the mount goes, and the folder falls back to the roboRIO's own storage
    Files.writeString(mounts, "ubi0:rootfs / ubifs rw 0 0\n");
    io.updateInputs(inputs);
    assertEquals("ok", inputs.status);
    assertEquals("ubi0:rootfs", inputs.device);
    assertFalse(inputs.onUsb);

    // Back in (HindsightCompanion, not the reading, keeps OnUsb false from here)
    Files.writeString(mounts, stickIn);
    io.updateInputs(inputs);
    assertEquals("/dev/sda1", inputs.device);
    assertTrue(inputs.onUsb);
  }

  @Test
  void aPulledStickWhoseMountLingersIsOffUsb(@TempDir Path dir) throws IOException {
    Path stick = Files.createDirectories(dir.resolve("media/sda1"));
    Path mounts = dir.resolve("mounts");
    Files.writeString(mounts, "/dev/sda1 " + stick.toRealPath() + " vfat rw 0 0\n");
    LogDriveIOInputs inputs = new LogDriveIOInputs();
    new LogDriveIOReal(stick.toString(), mounts, device -> false).updateInputs(inputs);
    assertEquals("/dev/sda1", inputs.device);
    assertFalse(inputs.onUsb);
  }

  @Test
  void withoutProcMountsItSaysUnavailableAndNeverThrows(@TempDir Path dir) {
    LogDriveIOInputs inputs = new LogDriveIOInputs();
    new LogDriveIOReal(dir.toString(), dir.resolve("no-mounts")).updateInputs(inputs);
    assertTrue(inputs.status.startsWith("unavailable: "), inputs.status);
    assertFalse(inputs.onUsb);
  }
}
