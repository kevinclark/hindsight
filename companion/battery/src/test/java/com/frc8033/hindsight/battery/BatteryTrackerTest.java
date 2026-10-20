package com.frc8033.hindsight.battery;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class BatteryTrackerTest {
  @Test
  void normalizeTrimsAndUpperCases() {
    assertEquals("B07", BatteryTracker.normalize("  b07 "));
  }

  @Test
  void normalizeTreatsBlankAndNullAsUnset() {
    assertEquals("", BatteryTracker.normalize("   "));
    assertEquals("", BatteryTracker.normalize(null));
  }

  @Test
  void gaugeIdPrefersNickname() {
    assertEquals("B03", BatteryTracker.gaugeId(true, " b03", 12345));
  }

  @Test
  void gaugeIdFallsBackToSerial() {
    assertEquals("BFG-12345", BatteryTracker.gaugeId(true, "", 12345));
  }

  @Test
  void gaugeIdIsEmptyWhenDisconnectedOrBlank() {
    assertEquals("", BatteryTracker.gaugeId(false, "B03", 12345));
    assertEquals("", BatteryTracker.gaugeId(true, "", 0));
  }

  @Test
  void resolvePrefersLiveGauge() {
    assertEquals(
        new BatteryTracker.Resolved("B03", "gauge"), BatteryTracker.resolve("B03", "B03", "B07"));
  }

  @Test
  void resolveKeepsLastGaugeIdWhenGaugeDropsOut() {
    assertEquals(
        new BatteryTracker.Resolved("B03", "gauge-cached"),
        BatteryTracker.resolve("", "B03", "B07"));
  }

  @Test
  void resolveFallsBackToTypedThenNone() {
    assertEquals(
        new BatteryTracker.Resolved("B07", "dashboard"), BatteryTracker.resolve("", "", "B07"));
    assertEquals(new BatteryTracker.Resolved("", "none"), BatteryTracker.resolve("", "", ""));
  }
}
