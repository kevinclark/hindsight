package com.frc8033.battery;

import com.playingwithfusion.BattFuelGauge;

public class BatteryGaugeIOReal implements BatteryGaugeIO {
  private final BattFuelGauge gauge;

  /** Every battery's gauge must keep this CAN ID, or it logs as disconnected. */
  public BatteryGaugeIOReal(int canId) {
    gauge = new BattFuelGauge(canId);
  }

  @Override
  public void updateInputs(BatteryGaugeIOInputs inputs) {
    inputs.connected = gauge.isConnected();
    long serialNumber = inputs.connected ? gauge.getSerialNumber() : 0;
    double ratedCapacityAh = inputs.connected ? gauge.getRatedCapacityAh() : 0.0;
    inputs.valid = isValid(inputs.connected, serialNumber, ratedCapacityAh);
    if (!inputs.valid) {
      // Don't leave the last reading in the log looking current
      inputs.serialNumber = 0;
      inputs.nickname = "";
      inputs.effectiveCapacityAh = 0.0;
      inputs.ratedCapacityAh = 0.0;
      inputs.remainingChargePct = 0.0;
      inputs.numCycles = 0;
      inputs.batteryAgeDays = 0.0;
      return;
    }
    inputs.serialNumber = serialNumber;
    String nickname = gauge.getNickname();
    inputs.nickname = nickname == null ? "" : nickname;
    inputs.effectiveCapacityAh = gauge.getEffectiveCapacityAh();
    inputs.ratedCapacityAh = ratedCapacityAh;
    inputs.remainingChargePct = gauge.getRemainingChargePct();
    inputs.numCycles = gauge.getNumCycles();
    inputs.batteryAgeDays = gauge.getBatteryAgeDays();
  }

  /**
   * In-season snapshots include gauges that answered with serial 0, capacity 0 and values like
   * 7e+228, so a connected gauge isn't trusted until its serial and rated capacity look real.
   */
  static boolean isValid(boolean connected, long serialNumber, double ratedCapacityAh) {
    return connected && serialNumber != 0 && ratedCapacityAh > 0.0 && ratedCapacityAh < 100.0;
  }
}
