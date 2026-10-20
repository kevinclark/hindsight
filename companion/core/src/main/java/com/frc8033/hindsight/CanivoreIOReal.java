package com.frc8033.hindsight;

import com.ctre.phoenix6.CANBus;
import com.ctre.phoenix6.CANBus.CANBusStatus;
import java.util.function.Supplier;

public class CanivoreIOReal implements CanivoreIO {
  private final Supplier<CANBusStatus> readStatus;

  /** getStatus() can block for up to 1 ms (CTRE's API doc), so it's read once a second. */
  public CanivoreIOReal(CANBus bus) {
    this(bus::getStatus);
  }

  CanivoreIOReal(Supplier<CANBusStatus> readStatus) {
    this.readStatus = readStatus;
  }

  @Override
  public void updateInputs(CanivoreIOInputs inputs) {
    CANBusStatus status = readStatus.get();
    inputs.status = status.Status == null ? "unknown" : status.Status.name();
    inputs.utilizationPercent = status.BusUtilization * 100.0;
    inputs.busOffCount = status.BusOffCount;
    inputs.txFullCount = status.TxFullCount;
    inputs.rec = status.REC;
    inputs.tec = status.TEC;
  }
}
