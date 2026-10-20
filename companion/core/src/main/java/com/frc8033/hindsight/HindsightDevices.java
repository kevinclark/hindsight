package com.frc8033.hindsight;

import com.ctre.phoenix6.hardware.CANcoder;
import com.ctre.phoenix6.hardware.CANdi;
import com.ctre.phoenix6.hardware.CANdle;
import com.ctre.phoenix6.hardware.CANrange;
import com.ctre.phoenix6.hardware.Pigeon2;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.hardware.TalonFXS;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Watches CTRE devices for Hindsight and Foresight: is each one answering, its firmware, its live
 * and sticky faults, and whether it rebooted. Call {@code watch} once per device, on the line
 * right after you make it:
 *
 * <pre>{@code
 * motor = new TalonFX(15, canBus);
 * HindsightDevices.watch(motor);
 * }</pre>
 *
 * <p>{@link HindsightCompanion#periodic()} reads every watched device once a second, on a real
 * robot only, and logs it under /Hindsight/Devices/&lt;bus&gt;/&lt;model&gt;/&lt;id&gt;/. Without a
 * HindsightCompanion nothing is logged. It never configures a device, sets a signal rate, or
 * touches your code's own signal objects. Watching one device twice keeps one entry.
 */
public final class HindsightDevices {
  /** One watched device: where it logs, what to call it in an alert, and how to read it. */
  record Watched(String key, String name, DeviceIO io, DeviceIOInputsAutoLogged inputs) {}

  private static final Map<String, Watched> watched = new LinkedHashMap<>();

  private HindsightDevices() {}

  public static void watch(TalonFX device) {
    add(device.getNetwork().getName(), "TalonFX", device.getDeviceID(), () -> DeviceIOReal.of(device));
  }

  public static void watch(TalonFXS device) {
    add(device.getNetwork().getName(), "TalonFXS", device.getDeviceID(), () -> DeviceIOReal.of(device));
  }

  public static void watch(CANcoder device) {
    add(device.getNetwork().getName(), "CANcoder", device.getDeviceID(), () -> DeviceIOReal.of(device));
  }

  public static void watch(Pigeon2 device) {
    add(device.getNetwork().getName(), "Pigeon2", device.getDeviceID(), () -> DeviceIOReal.of(device));
  }

  public static void watch(CANdi device) {
    add(device.getNetwork().getName(), "CANdi", device.getDeviceID(), () -> DeviceIOReal.of(device));
  }

  public static void watch(CANrange device) {
    add(device.getNetwork().getName(), "CANrange", device.getDeviceID(), () -> DeviceIOReal.of(device));
  }

  public static void watch(CANdle device) {
    add(device.getNetwork().getName(), "CANdle", device.getDeviceID(), () -> DeviceIOReal.of(device));
  }

  /** The IO is made only for a device not watched yet. */
  static synchronized void add(String busName, String model, int id, Supplier<DeviceIO> io) {
    String bus = HindsightCompanion.label(busName);
    String key = bus + "/" + model + "/" + id;
    if (!watched.containsKey(key)) {
      watched.put(key, new Watched(key, model + " " + id + " on " + bus, io.get(), new DeviceIOInputsAutoLogged()));
    }
  }

  static synchronized List<Watched> all() {
    return new ArrayList<>(watched.values());
  }

  /** Forgets every watched device. For tests. */
  public static synchronized void reset() {
    watched.clear();
  }
}
