package com.frc8033.hindsight.battery;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.littletonrobotics.junction.LogTable;

/**
 * The battery module logs exactly the keys companion/keys.json lists for it. Hindsight's battery
 * rules and profiles read these names, so they must not change.
 */
class KeysTest {
  @Test
  void batteryLogsExactlyTheListedKeys() throws IOException {
    LogTable table = new LogTable(0);
    new BatteryGaugeIOInputsAutoLogged().toLog(table.getSubtable(BatteryTracker.GAUGE_KEY));
    Map<String, String> logged = new TreeMap<>();
    table.getAll(false).forEach((key, value) -> logged.put(key, value.type.getWPILOGType()));
    // Strings logged with Logger.recordOutput (under /RealOutputs) and a LoggedNetworkString
    logged.put("/RealOutputs/" + BatteryTracker.ID_KEY, "string");
    logged.put("/RealOutputs/" + BatteryTracker.ID_SOURCE_KEY, "string");
    logged.put("/NetworkInputs" + BatteryTracker.TYPED_ID_KEY, "string");

    JsonNode root = new ObjectMapper().readTree(new File(System.getProperty("hindsight.keys")));
    Map<String, String> listed = new TreeMap<>();
    for (JsonNode entry : root.get("keys")) {
      if (entry.get("module").asText().equals("battery")) {
        listed.put(entry.get("key").asText(), entry.get("type").asText());
      }
    }
    assertEquals(listed, logged);
  }
}
