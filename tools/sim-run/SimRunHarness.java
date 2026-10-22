// Runs a team's robot program in WPILib desktop simulation and plays a scripted Driver Station timeline against it.
//
// sim-run (scripts/sim-run.ts) starts the robot's own jar with this class as the main class:
//
//   java -cp <this folder>:<robot jar> SimRunHarness <timeline file> <log file> <robot main class>
//
// Before the robot program starts, it registers command-scheduler hooks, so every command start, finish and
// interrupt is printed with its requirements. It then calls the robot's own main(), unchanged. A second thread waits
// for the robot program to finish starting, records every AdvantageKit NetworkTables value into a .wpilog (key names
// as AdvantageKit's own log uses them), and plays the timeline: robot mode, alliance and controller inputs.
//
// Everything it prints is one line: "[sim-run] <tab> <robot time, s> <tab> <kind> <tab> <fields...>". The robot's
// own prints come out the same way, as kind "out" or "err".
//
// It is compiled against each robot's own jar, so it reads like plain WPILib code. The few calls that differ between
// WPILib years (2022 to 2026) go through reflection, and are skipped with a printed reason when missing.

import edu.wpi.first.hal.AllianceStationID;
import edu.wpi.first.hal.simulation.DriverStationDataJNI;
import edu.wpi.first.networktables.NetworkTable;
import edu.wpi.first.networktables.NetworkTableInstance;
import edu.wpi.first.wpilibj.RobotController;
import edu.wpi.first.wpilibj.simulation.DriverStationSim;
import edu.wpi.first.wpilibj.simulation.SimHooks;
import edu.wpi.first.wpilibj2.command.Command;
import edu.wpi.first.wpilibj2.command.CommandScheduler;
import edu.wpi.first.wpilibj2.command.Subsystem;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

public class SimRunHarness {
  private static final PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true);
  private static final Stamped robotOut = new Stamped("out");
  private static final Stamped robotErr = new Stamped("err");
  private static final int CONTROLLERS = 6;
  /** Assumed: a clean JVM shutdown takes well under this; past it, the run is stopped anyway. */
  private static final long EXIT_WATCHDOG_MS = 5000;

  public static void main(String[] args) throws Exception {
    System.setOut(new PrintStream(robotOut, true));
    System.setErr(new PrintStream(robotErr, true));
    watchCommands(CommandScheduler.getInstance());
    List<String> timeline = Files.readAllLines(new File(args[0]).toPath());
    Thread player = new Thread(() -> play(timeline, args[1]), "sim-run timeline");
    player.setDaemon(true);
    player.start();
    Class.forName(args[2]).getMethod("main", String[].class).invoke(null, (Object) new String[0]);
  }

  /** One line out, tab-separated, stamped with robot time. */
  static synchronized void say(String kind, String... fields) {
    // Locale.ROOT: a laptop set to a comma-decimal language would otherwise print "1,2345".
    String time = String.format(Locale.ROOT, "%.4f", now());
    StringBuilder line = new StringBuilder("[sim-run]\t").append(time).append('\t').append(kind);
    for (String field : fields) line.append('\t').append(field.replace('\t', ' '));
    out.println(line);
  }

  static double now() {
    return RobotController.getFPGATime() / 1e6;
  }

  // ---- Commands -----------------------------------------------------------------------------------------------

  static void watchCommands(CommandScheduler scheduler) {
    scheduler.onCommandInitialize(c -> say("init", describe(c, origin())));
    scheduler.onCommandFinish(c -> say("finish", describe(c, "")));
    BiConsumer<Object, Optional<?>> interrupted = (c, by) ->
        say("interrupt", describe((Command) c, ""), by.map(b -> describe((Command) b, "")).orElse(""));
    try {
      // WPILib 2024+: the interrupt hook also says which command did the interrupting.
      CommandScheduler.class.getMethod("onCommandInterrupt", BiConsumer.class).invoke(scheduler, interrupted);
    } catch (ReflectiveOperationException olderWpilib) {
      scheduler.onCommandInterrupt((Consumer<Command>) c -> interrupted.accept(c, Optional.empty()));
    }
  }

  /** "id|name|requirement,requirement|default|origin": one field, split by sim-run. */
  static String describe(Command c, String origin) {
    List<String> requirements = new ArrayList<>();
    boolean isDefault = false;
    for (Subsystem s : c.getRequirements()) {
      requirements.add(s instanceof SubsystemBase ? ((SubsystemBase) s).getName() : s.getClass().getSimpleName());
      isDefault |= CommandScheduler.getInstance().getDefaultCommand(s) == c;
    }
    Collections.sort(requirements); // a set prints in no fixed order; sim-run matches commands across runs by it
    String id = Integer.toHexString(System.identityHashCode(c));
    return String.join("|", id, c.getName(), String.join(",", requirements), isDefault ? "default" : "", origin);
  }

  /** What scheduled the command: "trigger" for a button or trigger binding, else the first frame in team code. */
  static String origin() {
    String firstTeamFrame = "";
    for (StackTraceElement frame : Thread.currentThread().getStackTrace()) {
      String name = frame.getClassName();
      if (name.startsWith("edu.wpi.first.wpilibj2.command.button.Trigger")) return "trigger";
      boolean library = name.startsWith("java.") || name.startsWith("jdk.") || name.startsWith("edu.wpi.");
      if (firstTeamFrame.isEmpty() && !library && !name.equals("SimRunHarness")) firstTeamFrame = frame.toString();
    }
    return firstTeamFrame;
  }

  // ---- Timeline ----------------------------------------------------------------------------------------------

  /** Waits for the robot program to start, then plays each "<seconds after start> <action> <arguments>" line. */
  static void play(List<String> timeline, String logPath) {
    try {
      SimHooks.waitForProgramStart();
      say("started");
      Log log = startLog(new File(logPath));
      setUpDriverStation();
      long startNanos = System.nanoTime();
      for (String line : timeline) {
        String[] words = line.trim().split("\\s+", 3);
        if (words.length < 2) continue;
        long waitNanos = startNanos + (long) (Double.parseDouble(words[0]) * 1e9) - System.nanoTime();
        if (waitNanos > 0) Thread.sleep(waitNanos / 1_000_000, (int) (waitNanos % 1_000_000));
        String action = words[1];
        String rest = words.length > 2 ? words[2] : "";
        if (action.equals("end")) {
          finish(log);
          return;
        }
        // Said before the robot can see it, so nothing the input starts is printed before the step itself.
        say("step", line.trim());
        act(action, rest);
        // Only tells the HAL that new data is there, as the WebSocket extension does. DriverStationSim's own
        // notifyNewData() also runs DriverStation.refreshData() on this thread, which deadlocked the robot loop.
        DriverStationDataJNI.notifyNewData();
      }
    } catch (Exception e) {
      say("harness-error", e.toString());
      Runtime.getRuntime().halt(3);
    }
  }

  static void setUpDriverStation() {
    for (int port = 0; port < CONTROLLERS; port++) {
      DriverStationSim.setJoystickAxisCount(port, 6);
      DriverStationSim.setJoystickButtonCount(port, 10);
      DriverStationSim.setJoystickPOVCount(port, 1);
      DriverStationSim.setJoystickIsXbox(port, true);
      DriverStationSim.setJoystickPOV(port, 0, -1);
    }
    DriverStationSim.setDsAttached(true);
  }

  static void act(String action, String rest) {
    String[] a = rest.split("\\s+");
    if (action.equals("mode")) {
      DriverStationSim.setAutonomous(a[0].equals("auto"));
      DriverStationSim.setTest(a[0].equals("test"));
      DriverStationSim.setEnabled(!a[0].equals("disabled"));
    } else if (action.equals("alliance")) {
      DriverStationSim.setAllianceStationId(AllianceStationID.valueOf(a[0]));
    } else if (action.equals("axis")) {
      DriverStationSim.setJoystickAxis(Integer.parseInt(a[0]), Integer.parseInt(a[1]), Double.parseDouble(a[2]));
    } else if (action.equals("button")) {
      DriverStationSim.setJoystickButton(Integer.parseInt(a[0]), Integer.parseInt(a[1]), a[2].equals("1"));
    } else if (action.equals("pov")) {
      DriverStationSim.setJoystickPOV(Integer.parseInt(a[0]), 0, Integer.parseInt(a[1]));
    } else if (action.equals("choosers")) {
      printChoosers();
    } else if (action.equals("select")) {
      String[] chooserAndOption = rest.split("\\|", 2);
      NetworkTableInstance.getDefault().getTable("SmartDashboard").getSubTable(chooserAndOption[0])
          .getEntry("selected").setString(chooserAndOption[1]);
    } else {
      throw new IllegalArgumentException("unknown timeline action " + action);
    }
  }

  /** Each SendableChooser on SmartDashboard: its key, its options (joined by |), its default and what is active. */
  static void printChoosers() {
    NetworkTable dashboard = NetworkTableInstance.getDefault().getTable("SmartDashboard");
    for (String key : dashboard.getSubTables()) {
      NetworkTable table = dashboard.getSubTable(key);
      if (!table.getEntry(".type").getString("").equals("String Chooser")) continue;
      String[] options = table.getEntry("options").getStringArray(new String[0]);
      say("chooser", key, String.join("|", options), table.getEntry("default").getString(""),
          table.getEntry("active").getString(""));
    }
  }

  static void finish(Log log) throws Exception {
    System.out.flush();
    System.err.flush();
    robotOut.sayLine();
    robotErr.sayLine();
    say("end");
    if (log != null) {
      try {
        NetworkTableInstance.class.getMethod("stopEntryDataLog", int.class).invoke(null, log.handle);
      } catch (ReflectiveOperationException e) {
        say("no-log", "couldn't stop the log's NetworkTables feed (" + e + "); closing it anyway");
      }
      log.writer.getClass().getMethod("close").invoke(log.writer);
    }
    // exit, not halt, so WPILib and the vendors run their own shutdown. Either way about one run in six then aborts in
    // native code ("libc++abi ... mutex lock failed"), after "end" is said and the log is closed, so no result is lost
    // (measured 2026-10-21: 21 of 121 runs with halt, 36 of 210 with exit). A watchdog halts if shutdown hangs.
    Thread watchdog = new Thread(() -> {
      try {
        Thread.sleep(EXIT_WATCHDOG_MS);
      } catch (InterruptedException e) {
        return;
      }
      Runtime.getRuntime().halt(0);
    }, "sim-run exit watchdog");
    watchdog.setDaemon(true);
    watchdog.start();
    System.exit(0);
  }

  // ---- The log ------------------------------------------------------------------------------------------------

  /**
   * Records every NetworkTables value AdvantageKit publishes under /AdvantageKit into a .wpilog, under the key its own
   * log would use (/AdvantageKit/RealOutputs/X becomes /RealOutputs/X). A background writer: a writer that writes on
   * the calling thread stalled the robot loop inside NetworkTables. Null (and a "no-log" line) where the robot's
   * WPILib can't.
   */
  static Log startLog(File file) {
    try {
      Object writer = newBackgroundLog(file);
      Class<?> dataLog = Class.forName("edu.wpi.first.util.datalog.DataLog");
      Method start = NetworkTableInstance.class.getMethod("startEntryDataLog", dataLog, String.class, String.class);
      int handle = (int) start.invoke(NetworkTableInstance.getDefault(), writer, "/AdvantageKit", "");
      return new Log(writer, handle);
    } catch (ReflectiveOperationException e) {
      say("no-log", "this WPILib version can't record NetworkTables to a log (" + e + ")");
      return null;
    }
  }

  /** The log writer and the NetworkTables subscription feeding it, so both can be stopped before exit. */
  static class Log {
    final Object writer;
    final int handle;

    Log(Object writer, int handle) {
      this.writer = writer;
      this.handle = handle;
    }
  }

  /** WPILib 2025+: DataLogBackgroundWriter. 2023–2024: DataLog itself was the background writer. */
  static Object newBackgroundLog(File file) throws ReflectiveOperationException {
    String dir = file.getParent();
    String name = file.getName();
    try {
      return Class.forName("edu.wpi.first.util.datalog.DataLogBackgroundWriter")
          .getConstructor(String.class, String.class, double.class).newInstance(dir, name, 0.25);
    } catch (ClassNotFoundException olderWpilib) {
      return Class.forName("edu.wpi.first.util.datalog.DataLog")
          .getConstructor(String.class, String.class, double.class).newInstance(dir, name, 0.25);
    }
  }

  /** Prints each line the robot program prints as a [sim-run] line, stamped with the robot time it was printed. */
  static class Stamped extends OutputStream {
    private final String stream;
    private final ByteArrayOutputStream line = new ByteArrayOutputStream();

    Stamped(String stream) {
      this.stream = stream;
    }

    @Override
    public synchronized void write(int b) {
      if (b != '\n') {
        line.write(b);
        return;
      }
      sayLine();
    }

    /**
     * Says the line so far: at each newline, and once before exit, so a last line without one isn't lost. Not from
     * flush(): an auto-flushing PrintStream flushes after every print(), which would split "a" + "b\n" in two.
     */
    synchronized void sayLine() {
      if (line.size() == 0) return;
      say(stream, line.toString().replace("\r", ""));
      line.reset();
    }
  }
}
