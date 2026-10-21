package io.github.kevinclark.hindsight.robotstarts;

import edu.wpi.first.hal.AllianceStationID;
import edu.wpi.first.hal.HAL;
import edu.wpi.first.hal.simulation.DriverStationDataJNI;
import edu.wpi.first.wpilibj.DriverStation;
import edu.wpi.first.wpilibj.RobotBase;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Hindsight's robot-starts check. Written into build/ by the io.github.kevinclark.hindsight Gradle plugin and
 * compiled against this robot's own WPILib: edit the plugin, not this copy.
 *
 * <p>Turns the robot on like at the field: build it, let the Driver Station connect after it boots, then run the real
 * robot loop disabled, in auto, in teleop and disabled again. Fails if the robot code throws or its loop stops. The
 * verdict ("passed", or what went wrong in words a student can act on) goes to the file named by hindsight.result.
 */
public final class HindsightRobotStarts {
  private static final long BUILD_TIMEOUT_MS = 60_000; // a first Phoenix start in simulation took 11 s
  private static final long LOOP_TIMEOUT_MS = 15_000; // a stuck loop fails the check instead of hanging the build
  private static final int HAL_TIMEOUT_MS = 500; // what WPILib's own RobotBase.startRobot passes
  // each mode's init and a periodic, with one to spare; 10 per mode caught nothing more on the history (measured)
  private static final int LOOPS_PER_MODE = 2;
  private static final int LOOPS_DISABLED_AFTER = 1;
  private static final long POLL_MS = 5;

  /** A mode the check waits for, and how the robot's own DriverStation says it is in it. */
  private enum Mode {
    DISABLED("disabled"),
    AUTONOMOUS("in autonomous"),
    TELEOP("in teleop");

    private final String words;

    Mode(String words) {
      this.words = words;
    }

    boolean isCurrent() {
      switch (this) {
        case AUTONOMOUS:
          return DriverStation.isAutonomousEnabled();
        case TELEOP:
          return DriverStation.isTeleopEnabled();
        default:
          return DriverStation.isDisabled();
      }
    }
  }

  private final Class<?> robotClass;
  private final AtomicInteger loops = new AtomicInteger(); // loops the robot finished in the expected mode
  private volatile Mode expected = Mode.DISABLED;
  private final CountDownLatch built = new CountDownLatch(1);
  private volatile String phase;
  private volatile RobotBase robot;
  private volatile Throwable crash;
  private volatile String crashPhase;

  public static void main(String[] args) throws Exception {
    String verdict;
    try {
      new HindsightRobotStarts(robotClass(System.getProperty("hindsight.robotClass"))).run();
      verdict = "passed";
    } catch (Failed e) {
      verdict = e.getMessage();
      e.printStackTrace(); // the whole story, in the console output file
    } catch (Throwable t) {
      verdict = "Hindsight's robot-starts check hit an error of its own: " + t;
      t.printStackTrace();
    }
    System.out.println("Hindsight robot-starts: " + verdict);
    Files.writeString(Path.of(System.getProperty("hindsight.result")), verdict);
    System.exit(verdict.equals("passed") ? 0 : 1); // robot code leaves threads running
  }

  private HindsightRobotStarts(Class<?> robotClass) {
    this.robotClass = robotClass;
  }

  private static Class<?> robotClass(String name) {
    try {
      return Class.forName(name, false, HindsightRobotStarts.class.getClassLoader());
    } catch (ClassNotFoundException e) {
      throw new Failed("Hindsight couldn't find the robot class " + name + ". If yours has another name, set it in "
          + "build.gradle: hindsight { robotClass = 'your.package.Robot' }", null);
    }
  }

  private void run() throws Exception {
    if (!HAL.initialize(HAL_TIMEOUT_MS, 0)) throw new Failed("Hindsight couldn't start WPILib's simulator.", null);
    phase = "while building the robot (new " + robotClass.getSimpleName() + "())";
    // HAL calls this on the robot thread at the end of every robot loop in simulation, command-based or not. A loop
    // counts only in the mode being checked, so a robot that never enables can't pass.
    try (HAL.SimPeriodicAfterCallback counter = HAL.registerSimPeriodicAfterCallback(this::countLoop)) {
      Thread robotThread = new Thread(this::buildAndRun, "robot");
      robotThread.setDaemon(true);
      robotThread.start();
      if (!built.await(BUILD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
        throw new Failed("The robot took longer than " + BUILD_TIMEOUT_MS / 1000 + " s " + phase
            + ". Something in its constructor is waiting or looping forever.", null);
      }
      checkForCrash();
      // at the field the code boots first, then the Driver Station connects: code that waits for that (an
      // "add autos when the DS connects" trigger) only runs if it comes after
      DriverStationSim.setAllianceStationId(AllianceStationID.Blue1);
      DriverStationSim.setDsAttached(true);
      try {
        runLoops(Mode.DISABLED, "while disabled, after the Driver Station connected", LOOPS_PER_MODE);
        runLoops(Mode.AUTONOMOUS, "in autonomous", LOOPS_PER_MODE);
        runLoops(Mode.TELEOP, "in teleop", LOOPS_PER_MODE);
        runLoops(Mode.DISABLED, "while disabled after teleop", LOOPS_DISABLED_AFTER);
      } finally {
        if (robot != null) robot.endCompetition();
        robotThread.join(LOOP_TIMEOUT_MS);
      }
      checkForCrash();
      if (robotThread.isAlive()) throw new Failed("The robot loop didn't stop when asked (endCompetition).", null);
    }
  }

  /** On the robot thread: build the robot, then run its real loop (every 20 ms) until endCompetition. */
  private void buildAndRun() {
    try {
      Constructor<?> constructor = robotClass.getDeclaredConstructor();
      constructor.setAccessible(true);
      try {
        robot = (RobotBase) constructor.newInstance();
      } catch (InvocationTargetException e) {
        throw e.getCause();
      }
      phase = "while disabled, before the Driver Station connected";
      built.countDown();
      robot.startCompetition();
    } catch (Throwable t) {
      crashPhase = phase;
      crash = t;
      built.countDown();
    }
  }

  private void countLoop() {
    if (expected.isCurrent()) loops.incrementAndGet();
  }

  private void runLoops(Mode mode, String phase, int count) throws InterruptedException {
    this.phase = phase;
    int target = loops.get() + count;
    expected = mode;
    DriverStationSim.setAutonomous(mode == Mode.AUTONOMOUS); // mode first, so no loop sees "enabled" in the old mode
    DriverStationSim.setEnabled(mode != Mode.DISABLED);
    // only signal new data: DriverStationSim.notifyNewData() would also read it on this thread, racing the robot
    // loop (a deadlock measured in the sim-run tool)
    DriverStationDataJNI.notifyNewData();
    long deadline = System.currentTimeMillis() + LOOP_TIMEOUT_MS;
    while (loops.get() < target) {
      checkForCrash();
      if (System.currentTimeMillis() > deadline) {
        throw new Failed("The robot didn't run " + mode.words + ": fewer than " + count + " loops " + mode.words
            + " in " + LOOP_TIMEOUT_MS / 1000 + " s. Either something in the robot code is waiting or looping"
            + " forever, or the robot never switched to that mode.", null);
      }
      Thread.sleep(POLL_MS);
    }
  }

  private void checkForCrash() {
    Throwable thrown = crash;
    if (thrown != null) throw new Failed(describe(thrown, crashPhase), thrown);
  }

  /**
   * When it crashed, what was thrown, and the lines of the team's own code it went through ("their own code" being
   * any class loaded from where the robot class was).
   */
  private String describe(Throwable thrown, String phase) {
    List<Throwable> chain = new ArrayList<>(); // the deepest cause first
    for (Throwable t = thrown; t != null && !chain.contains(t); t = t.getCause()) chain.add(0, t);
    Throwable root = chain.get(0);
    StringBuilder text = new StringBuilder("The robot code crashed ").append(phase).append(":\n  ")
        .append(root.getClass().getSimpleName());
    if (root.getMessage() != null) text.append(": ").append(root.getMessage());
    List<StackTraceElement> lines = robotCodeLines(chain);
    for (int i = 0; i < lines.size(); i++) {
      text.append(i == 0 ? "\n  in your code at " : "\n            from ").append(lines.get(i));
    }
    if (chain.stream().anyMatch(t -> mentions(t, "org.littletonrobotics.junction.LogFileUtil"))) {
      text.append("\nAdvantageKit is in replay mode and asked for a log file to replay. Set the robot's mode to SIM"
          + " for simulation.");
    } else if (simulationClass(lines) != null) {
      // a crash in shared code reached through a *Sim class (an IO's constructor, say) crashes the real robot too
      text.append("\nIt went through ").append(simulationClass(lines)).append(", a simulation class. If the real"
          + " robot runs the same lines, it crashes the same way. Fix it, then build again.");
    } else {
      text.append("\nThe real robot would crash the same way. Fix it, then build again.");
    }
    return text.toString();
  }

  /** Up to three lines of robot code, innermost first, from the deepest exception that went through any. */
  private List<StackTraceElement> robotCodeLines(List<Throwable> chain) {
    Object robotCode = codeSource(robotClass.getName());
    if (robotCode == null) return List.of();
    for (Throwable t : chain) {
      List<StackTraceElement> lines = new ArrayList<>();
      for (StackTraceElement frame : t.getStackTrace()) {
        if (lines.size() < 3 && Objects.equals(codeSource(frame.getClassName()), robotCode)) {
          lines.add(frame);
        }
      }
      if (!lines.isEmpty()) return lines;
    }
    return List.of();
  }

  /** The first of these lines whose class is named like a simulation class (HoodIOSim), or null. */
  private static String simulationClass(List<StackTraceElement> lines) {
    for (StackTraceElement line : lines) {
      String className = line.getClassName().replaceAll("\\$.*", "");
      String simpleName = className.substring(className.lastIndexOf('.') + 1);
      if (simpleName.endsWith("Sim")) return simpleName;
    }
    return null;
  }

  private static Object codeSource(String className) {
    try {
      CodeSource source = Class.forName(className, false, HindsightRobotStarts.class.getClassLoader())
          .getProtectionDomain().getCodeSource();
      return source == null ? null : source.getLocation();
    } catch (ClassNotFoundException | LinkageError e) {
      return null; // a JDK-internal or generated class: not robot code
    }
  }

  private static boolean mentions(Throwable t, String className) {
    for (StackTraceElement frame : t.getStackTrace()) {
      if (frame.getClassName().equals(className)) return true;
    }
    return false;
  }

  /** The check's verdict, in words for a student. */
  private static final class Failed extends RuntimeException {
    Failed(String message, Throwable cause) {
      super(message, cause);
    }
  }
}
