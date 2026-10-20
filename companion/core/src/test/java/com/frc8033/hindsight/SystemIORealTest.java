package com.frc8033.hindsight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.frc8033.hindsight.SystemIO.SystemIOInputs;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SystemIORealTest {
  @Test
  void cpuTimesAddUpTheFirstEightColumnsAndCountIowaitAsIdle() {
    assertEquals(
        new SystemIOReal.CpuTimes(63350, 50100), SystemIOReal.parseCpuTimes(Fixtures.proc("stat-1")));
  }

  @Test
  void cpuPercentIsTheBusyShareBetweenTwoReads() {
    SystemIOReal.CpuTimes before = SystemIOReal.parseCpuTimes(Fixtures.proc("stat-1"));
    SystemIOReal.CpuTimes after = SystemIOReal.parseCpuTimes(Fixtures.proc("stat-2"));
    assertEquals(100.0 * 950 / 1850, SystemIOReal.cpuPercent(before, after), 1e-9);
    assertEquals(0.0, SystemIOReal.cpuPercent(after, after));
  }

  @Test
  void garbledProcStatIsUnreadable() {
    assertNull(SystemIOReal.parseCpuTimes(null));
    assertNull(SystemIOReal.parseCpuTimes("cpu  10 x 30 40 50"));
    assertNull(SystemIOReal.parseCpuTimes("intr 1 2 3"));
  }

  @Test
  void memoryIsReadInBytes() {
    assertEquals(
        new SystemIOReal.Memory(200000L * 1024, 510000L * 1024),
        SystemIOReal.parseMemory(Fixtures.proc("meminfo")));
  }

  @Test
  void memoryWithoutMemAvailableIsUnreadable() {
    assertNull(SystemIOReal.parseMemory(Fixtures.proc("meminfo-old-kernel")));
  }

  @Test
  void firstReadWaitsForASecondCpuSampleThenReadsEverything(@TempDir Path dir) throws IOException {
    Path stat = dir.resolve("stat");
    Path meminfo = dir.resolve("meminfo");
    Files.writeString(stat, Fixtures.proc("stat-1"));
    Files.writeString(meminfo, Fixtures.proc("meminfo"));
    SystemIOReal io = new SystemIOReal(stat, meminfo);
    SystemIOInputs inputs = new SystemIOInputs();

    io.updateInputs(inputs);
    assertEquals("first CPU sample", inputs.status);
    assertEquals(0.0, inputs.cpuPercent);
    assertEquals(200000L * 1024, inputs.memAvailableBytes);

    Files.writeString(stat, Fixtures.proc("stat-2"));
    io.updateInputs(inputs);
    assertEquals("ok", inputs.status);
    assertEquals(51.35, inputs.cpuPercent, 0.01);
    assertTrue(inputs.heapUsedBytes > 0);
    assertTrue(inputs.heapMaxBytes >= inputs.heapUsedBytes);
  }

  @Test
  void withoutProcItSaysUnavailableAndNeverThrows(@TempDir Path dir) {
    SystemIOReal io = new SystemIOReal(dir.resolve("no-stat"), dir.resolve("no-meminfo"));
    SystemIOInputs inputs = new SystemIOInputs();
    io.updateInputs(inputs);
    io.updateInputs(inputs);
    assertTrue(inputs.status.startsWith("unavailable: "), inputs.status);
    assertTrue(inputs.status.contains("no-stat") && inputs.status.contains("no-meminfo"));
    assertEquals(0.0, inputs.cpuPercent);
    assertEquals(0, inputs.memAvailableBytes);
    assertTrue(inputs.heapMaxBytes > 0);
  }
}
