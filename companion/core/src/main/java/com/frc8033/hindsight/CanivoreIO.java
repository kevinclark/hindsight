package com.frc8033.hindsight;

import org.littletonrobotics.junction.AutoLog;

/** One CANivore's own bus status (Phoenix 6 CANBus.getStatus()). */
public interface CanivoreIO {
  @AutoLog
  public static class CanivoreIOInputs {
    /** Phoenix's status code for the read: "OK", or why the bus couldn't be read. */
    public String status = "not read";

    /** How busy the bus is, 0 to 100. CTRE: keep it under 90. */
    public double utilizationPercent = 0.0;

    /** Times the CANivore turned off its bus after too many errors. */
    public int busOffCount = 0;

    /** Times a frame couldn't be sent because the transmit buffer was full. */
    public int txFullCount = 0;

    /** Receive error counter: goes up on errors, back down on good frames. */
    public int rec = 0;

    /** Transmit error counter: goes up on errors, back down on good frames. */
    public int tec = 0;
  }

  /** Does nothing by default, so sim and replay use the logged values. */
  public default void updateInputs(CanivoreIOInputs inputs) {}
}
