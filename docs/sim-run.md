# sim-run: try your robot code in the simulator before it reaches the robot

sim-run builds your robot code, runs it in WPILib's desktop simulator with no window, drives it like a Driver
Station would (enable, disable, auto, teleop, alliance, controller buttons), and tells you what went wrong: a crash,
a zero that got cut off, an auto that never finishes or never moves, a robot that drives the same way on red as on
blue, and anything you told it to expect.

It never changes your folder. It copies your code (including changes you haven't committed) to a folder of its own
and builds the copy there.

## Run it

You need WPILib installed (sim-run uses its Java) and Node 22.18 or newer.

```
node scripts/sim-run.ts ../my-robot-code
```

Run it from the Hindsight folder. It takes a few minutes: the simulator runs in real time, and every auto runs once on
each alliance. Useful options:

| Option | What it does |
|---|---|
| `--only autos` | run only some scenarios: `startup`, `autos`, `drive`, or part of a scenario's name |
| `--commit abc1234` | test one commit instead of your working tree |
| `--scenarios file.json` | your scenario file, if it isn't `sim-run.json` in the robot folder |
| `--repeat 3` | run each scenario 3 times (for anything that depends on timing) |
| `--verbose` | also print every command's start and end, run by run |
| `--java <folder>` | the JDK to use, if not WPILib's |

It exits with 1 when it found a problem, so a CI job can run it too.

## What it runs without a scenario file

- **Start up and enable twice** (teleop 5 s, disabled 2 s, teleop 5 s): crashes at start, and whether each zero runs on
  every enable.
- **Every auto in your auto chooser, on blue and on red**, each on a freshly started robot: a crash, an auto still
  running when auto ends (compared with your default auto), an auto that doesn't move the robot, and an auto that
  moves the same way on red as on blue.
- **Drive forward on blue and on red**: the left stick pushed forward for 1.5 s. Forward should drive away from your
  own driver station on both alliances.

If your robot has a [Hindsight robot profile](robot-profile.md), sim-run also uses its zeroes, its pose key and its
auto chooser, and runs Hindsight's log rules on each run's log.

## Your scenario file

Put `sim-run.json` in your robot-code folder. Everything in it is optional.

```json
{
  "controllers": { "driver": 0, "operator": 1 },
  "zeroes": [
    { "name": "hood", "done": "Rezeroed hood", "once": true }
  ],
  "autos": { "chooser": "Autos", "alliances": ["blue1", "red1"], "skip": ["Test auto"] },
  "drive": { "forward": { "driver": "leftY", "value": -1 } },
  "scenarios": [
    {
      "name": "Zero the intake",
      "alliance": "blue1",
      "steps": [
        { "disabled": 3 },
        { "teleop": 6, "press": [
          { "at": 0.5, "driver": "b", "for": 5,
            "expect": [{ "message": "Intake zeroed", "within": 3 }, { "finish": true, "within": 3 }] }
        ] }
      ]
    }
  ]
}
```

- **controllers**: your names for the controller ports. A press says which controller, by name.
- **zeroes**: each mechanism that zeroes against a hard stop, and the exact text your code prints when it's done
  (`done`, a regular expression). sim-run finds the command that prints it, and tells you when that command is cut off
  by another one before it's done, or never finishes. `"once": true` says it should zero once per robot start, not on
  every enable.
- **autos**: the SmartDashboard key of your auto chooser (needed only when you have more than one chooser), the
  alliances to run each auto on, and autos to skip.
- **drive**: the input that drives forward (`"drive": false` turns the drive check off).
- **scenarios**: your own. Each has steps, run in order; a step is one robot mode and how long it lasts
  (`{ "teleop": 5 }`). Start with `{ "disabled": 3 }`: the robot code needs a moment after it starts. Give
  `"alliances": ["blue1", "red1"]` to run it on both and compare them.
- **press**: an input during a step: `at` seconds after the step starts, which controller and which input, held
  `for` seconds (or to the end of the step), and `value` for a stick or trigger (default 1). Inputs are Xbox names:
  `a b x y leftBumper rightBumper back start leftStick rightStick`, `leftX leftY leftTrigger rightTrigger rightX
  rightY`, `povUp povRight povDown povLeft`.
- **expect**, on a press, each `within` seconds of it:
  - `{ "message": "text" }`: your code prints this;
  - `{ "finish": true }`: the commands this press started finish (not still running, not cut off);
  - `{ "key": "/RealOutputs/Superstructure/State", "becomes": "INTAKE" }`: a value in your AdvantageKit log becomes
    this.

## Reading the report

Problems come first, then warnings, then notes. Each says what happened, in which run, and what to look at. Commands
appear as their class and the subsystems they need, `ParallelCommandGroup (needs Drum, Intake)`, because that's all a
command tells the scheduler. Give your commands names (`.withName("Intake")`) and the report uses them.

"Cut off by another" in *what each run did* is normal: every time a state machine changes state, the new state's
command takes over the subsystems. It becomes a problem only for a zero, or a command you said must finish.

## What it can't tell you

- Commands that start in the same loop run in a different order on a laptop than on the roboRIO, so a race can go the
  other way on the robot.
- Simulated motors ignore inversion and share your real constants: a wrong invert or gear ratio looks fine.
- Phoenix simulation runs in real time, so scenarios cost as long as they say.
- Loop times are your laptop's, not the roboRIO's.
- Vision and game pieces are simulated or missing.
- Never run it on the Driver Station laptop.

## How it works

`src/simrun/launch.ts` copies and builds the code (GradleRIO's `simulateExternalJavaRelease`, offline first), then
starts your jar with `tools/sim-run/SimRunHarness.java` as the main class. The harness registers command-scheduler
hooks, calls your `Main.main`, and on a second thread plays the timeline through `DriverStationSim` and records every
AdvantageKit NetworkTables value into a `.wpilog`. No HAL extension loads, so no window opens. The checks are in
`src/simrun/checks/`, one file each, written like Hindsight's rules.

Old robots: for WPILib 2022, sim-run adds WPILib's mirror of artifacts that left the internet with JCenter. On an
Apple-silicon Mac, WPILib 2022 needs an Intel JDK (`--java`), which runs under Rosetta. WPILib before 2023 records no
log, so pose checks are skipped.
