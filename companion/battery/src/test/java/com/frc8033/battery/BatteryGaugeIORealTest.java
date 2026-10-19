package com.frc8033.battery;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class BatteryGaugeIORealTest {
  @Test
  void validNeedsConnectionSerialAndSaneCapacity() {
    assertTrue(BatteryGaugeIOReal.isValid(true, 12345, 19.75));
    assertFalse(BatteryGaugeIOReal.isValid(false, 12345, 19.75));
    assertFalse(BatteryGaugeIOReal.isValid(true, 0, 19.75));
    assertFalse(BatteryGaugeIOReal.isValid(true, 12345, 0.0));
    assertFalse(BatteryGaugeIOReal.isValid(true, 12345, 7e228));
    assertFalse(BatteryGaugeIOReal.isValid(true, 12345, Double.NaN));
  }
}
