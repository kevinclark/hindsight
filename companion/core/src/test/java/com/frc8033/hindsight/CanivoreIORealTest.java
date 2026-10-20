package com.frc8033.hindsight;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.ctre.phoenix6.CANBus.CANBusStatus;
import com.ctre.phoenix6.StatusCode;
import com.frc8033.hindsight.CanivoreIO.CanivoreIOInputs;
import org.junit.jupiter.api.Test;

class CanivoreIORealTest {
  static CANBusStatus status(StatusCode code, float utilization, int busOffs, int rec, int tec) {
    CANBusStatus status = new CANBusStatus();
    status.Status = code;
    status.BusUtilization = utilization;
    status.BusOffCount = busOffs;
    status.TxFullCount = 3;
    status.REC = rec;
    status.TEC = tec;
    return status;
  }

  @Test
  void copiesEveryFieldAndGivesUtilizationAsAPercent() {
    CanivoreIOInputs inputs = new CanivoreIOInputs();
    new CanivoreIOReal(() -> status(StatusCode.OK, 0.42f, 1, 5, 7)).updateInputs(inputs);
    assertEquals("OK", inputs.status);
    assertEquals(42.0, inputs.utilizationPercent, 1e-4);
    assertEquals(1, inputs.busOffCount);
    assertEquals(3, inputs.txFullCount);
    assertEquals(5, inputs.rec);
    assertEquals(7, inputs.tec);
  }

  @Test
  void aBusThatCantBeReadLogsPhoenixsReason() {
    CanivoreIOInputs inputs = new CanivoreIOInputs();
    new CanivoreIOReal(() -> status(StatusCode.InvalidNetwork, 0f, 0, 0, 0)).updateInputs(inputs);
    assertEquals("InvalidNetwork", inputs.status);
  }
}
