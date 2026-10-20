package com.frc8033.hindsight;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.littletonrobotics.junction.LogTable;

/** The core logs exactly the keys companion/keys.json lists for it, with the same types. */
class KeysTest {
  static Map<String, String> listedKeys(String module, String busLabel) throws IOException {
    JsonNode root = new ObjectMapper().readTree(new File(System.getProperty("hindsight.keys")));
    Map<String, String> keys = new TreeMap<>();
    for (JsonNode entry : root.get("keys")) {
      if (entry.get("module").asText().equals(module)) {
        keys.put(entry.get("key").asText().replace("{bus}", busLabel), entry.get("type").asText());
      }
    }
    return keys;
  }

  @Test
  void coreLogsExactlyTheListedKeys() throws IOException {
    HindsightCompanion companion =
        new HindsightCompanion(
            false,
            new SystemIO() {},
            new LogDriveIO() {},
            Map.of("Any", new CanivoreIO() {}),
            type -> (active, text) -> {});
    LogTable table = new LogTable(0);
    companion.forEachInputs((key, inputs) -> inputs.toLog(table.getSubtable(key)));

    Map<String, String> logged = new TreeMap<>();
    table.getAll(false).forEach((key, value) -> logged.put(key, value.type.getWPILOGType()));
    assertEquals(listedKeys("core", "Any"), logged);
  }
}
