package com.frc8033.battery;

import org.littletonrobotics.junction.AutoLog;

/** The Playing With Fusion Battery Fuel Gauge on the battery. */
public interface BatteryGaugeIO {
  @AutoLog
  public static class BatteryGaugeIOInputs {
    public boolean connected = false;

    /** Connected and reporting sane data; gauges have sent serial 0 and junk values. */
    public boolean valid = false;

    public long serialNumber = 0;
    public String nickname = "";
    public double effectiveCapacityAh = 0.0;
    public double ratedCapacityAh = 0.0;
    public double remainingChargePct = 0.0;
    public int numCycles = 0;
    public double batteryAgeDays = 0.0;
  }

  /** Does nothing by default, so sim and replay use the logged values. */
  public default void updateInputs(BatteryGaugeIOInputs inputs) {}
}
