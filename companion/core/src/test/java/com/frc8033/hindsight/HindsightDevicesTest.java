package com.frc8033.hindsight;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class HindsightDevicesTest {
  @AfterEach
  void forget() {
    HindsightDevices.reset();
  }

  @Test
  void eachDeviceIsKeyedByBusModelAndId() {
    HindsightDevices.add("*", "TalonFX", 15, () -> new DeviceIO() {});
    HindsightDevices.add("*", "CANcoder", 15, () -> new DeviceIO() {});
    HindsightDevices.add("", "Pigeon2", 0, () -> new DeviceIO() {});
    List<String> keys = HindsightDevices.all().stream().map(HindsightDevices.Watched::key).toList();
    assertEquals(List.of("Any/TalonFX/15", "Any/CANcoder/15", "rio/Pigeon2/0"), keys);
    assertEquals("TalonFX 15 on Any", HindsightDevices.all().get(0).name());
  }

  @Test
  void watchingTwiceKeepsOneEntryAndMakesOneReader() {
    int[] made = {0};
    for (int i = 0; i < 2; i++) {
      HindsightDevices.add("*", "TalonFX", 15, () -> {
        made[0]++;
        return new DeviceIO() {};
      });
    }
    assertEquals(1, HindsightDevices.all().size());
    assertEquals(1, made[0]);
  }
}
