# Hindsight build checks (Gradle plugin)

Checks that run when a WPILib Java robot project builds, so a crash or a silent math bug shows up on a laptop, not
at the field. One line adds them all; each can be turned off by name.

## Add it

In `build.gradle`, add the last line to `plugins {}` (WPILib's `settings.gradle` already lists the Gradle Plugin
Portal):

```groovy
plugins {
    id "java"
    id "edu.wpi.first.GradleRIO" version "2026.2.1"
    id "io.github.kevinclark.hindsight" version "0.1.0"
}
```

Then build once ("Build Robot Code"), read what it changed (`git diff`), fix anything it only warns about, and commit.
Not published yet: until it is on the Plugin Portal, see [Trying it before it's published](#trying-it-before-its-published).

## What it does

| Check | When | What you see |
|---|---|---|
| **Error Prone, an allowlist** (`errorProne`) | every compile | Every Error Prone warning is off except: the **alerts** `NarrowCalculation` (integer division), `EqualsIncompatibleType` (`Optional<Alliance>` compared with `Alliance`, always false) and `FallThrough` (a `switch` case that runs into the next), and the **tidy** checks `MissingOverride`, `UnnecessaryParentheses`, `OperatorPrecedence`, `UnnecessaryStringBuilder`. Javadoc checks and the rest stay off; javac's own warnings (deprecated for removal) stay. Generated code (AdvantageKit's `AutoLogged` classes) is skipped. On a laptop these are warnings; Error Prone's own always-on error checks (code that cannot be right: `DeadException`, `SelfAssignment`, ...) still fail a build, as they would with Error Prone alone. |
| **NullAway** (`nullAway`) | off unless `nullAway = true` | NullAway on the robot's package (`frc.robot` for `frc.robot.Robot`), as warnings. |
| **Fixed on laptops** (`fixIntegerDivision`, `fixStyle`) | laptop builds that warned about one; never a deploy, never CI | Error Prone's own fixes, in place: `50 / 12` (4 in Java) becomes `50 / 12.0`, and each tidy check's fix (adding `@Override`, dropping extra parentheses...). The build lists each file whose integer division it fixed, and counts the files it tidied with the checks that fired. The rewrite lands after that build compiled, so build again before you deploy. |
| **Strict in CI** (`strictInCi`) | `CI=true` (GitHub Actions sets it) | The three alerts are errors. Everything else keeps its severity. |
| **Robot starts** (`robotStarts`) | CI (`CI=true`); on a laptop run `./gradlew hindsightRobotStarts`, or set `robotStartsOnLaptop = true` to run it on every build; never deploy | Builds `frc.robot.Robot` in simulation, connects a Driver Station after it boots (as at the field) and runs the real robot loop disabled, in auto, in teleop and disabled again. A crash fails the build with the exception and the lines of your code it went through. The robot's console output goes to `build/hindsight/robot-starts/output.txt`. |
| **Format hook** (`formatHook`) | each `git commit`, once the clone has built | Runs the project's own `spotlessApply` and re-stages the files you had staged. A file that also has unstaged changes is committed exactly as you staged it; its working copy is formatted, like every file `spotlessApply` touches. It never blocks a commit; `--no-verify` skips it. |

A failing robot-starts check reads like this (Rebuilt `4b68c96^`, a field read before the constructor set it):

```
> The robot code crashed while building the robot (new Robot()):
    NullPointerException: Cannot invoke "com.ctre.phoenix6.hardware.TalonFX.getPosition()" because "this.hoodMotor" is null
    in your code at frc.robot.subsystems.hood.HoodIO.<init>(HoodIO.java:38)
              from frc.robot.subsystems.hood.HoodIOSim.<init>(HoodIOSim.java:30)
              from frc.robot.Robot.<init>(Robot.java:116)
  It went through HoodIOSim, a simulation class. If the real robot runs the same lines, it crashes the same way. Fix it, then build again.
```

## Turn something off

```groovy
hindsight {
    errorProne = false           // also turns off the checks that use it
    fixIntegerDivision = false   // warn about integer division, don't rewrite it
    fixStyle = false             // warn about the tidy checks, don't rewrite them
    nullAway = true              // on, as warnings (off by default)
    strictInCi = false           // CI warns instead of failing
    robotStarts = false
    robotStartsOnLaptop = true   // also run the robot-starts check on every laptop build (CI always does; 2.6 s of a 4.4 s warm build)
    formatHook = false           // the next build removes the hook it installed
    robotClass = "frc.robot.Robot"   // if your robot class has another name
}
```

To keep one whole-number division on purpose, put `@SuppressWarnings("NarrowCalculation")` on its field or method.

**With the CI code check too** ([Code check in your team's CI](../../README.md#code-check-in-your-teams-ci)): integer
division is this plugin's job in CI, so give the action `exclude-rules: code/integer-division` and each division is
reported once, by the compiler.

## Details

- **Why the fix waits for a second compile.** Error Prone's patch mode runs only the checks it patches, so patching
  inside `compileJava` would hide every other warning. `compileJava` warns as usual; only a build whose compile warned
  about one of the fixed checks runs `hindsightAutoFix`, a patch-only compile into `build/`. A warning not yet
  fixed (a deploy came first) is remembered in `build/`, so the next laptop build fixes it even with nothing to
  recompile. The fix's own compile never fails your build.
- **Why never on deploy.** A deploy ships what was just compiled, so it would carry the old values and the next deploy
  would change them with no edit. Any GradleRIO deploy task (a DeployUtils task, such as `deploy`'s roboRIO
  discovery) turns the fix off for that build; a task merely named like one, such as `eventDeploy`, doesn't. GradleRIO's
  `deploy` doesn't run `check`, so the robot-starts check never runs at the field either. It is in `check` only in CI
  or with `robotStartsOnLaptop = true`; `./gradlew hindsightRobotStarts` runs it by hand.
- **The robot-starts check** is written into `build/hindsight/robot-starts/` and compiled against your own WPILib by
  a task of its own (so your Spotless or Checkstyle never sees it), then run as its own Java process with WPILib's
  simulator libraries, the way GradleRIO runs tests. A loop counts only in the mode being checked, so a robot that
  never enables fails. It is up to date (skipped) while your compiled code and `src/main/deploy` haven't changed. Your code must build in simulation: an AdvantageKit robot
  left in `REPLAY` mode asks for a log file and fails (the message says so).
- **The format hook** is installed only in a git checkout where `build.gradle` is tracked, with a `spotlessApply`
  task, no `core.hooksPath`, and no `pre-commit` hook of your own. It is never installed in CI.
- Tested with GradleRIO 2025.2.1 and 2026.2.1 on macOS. Windows and Linux are not tested yet.

## Trying it before it's published

```
cd companion && ./gradlew :gradle-plugin:publish     # writes gradle-plugin/build/repo
```

Then build the robot with an init script that puts that repo ahead of the Plugin Portal:

```groovy
// local-plugin.init.gradle
beforeSettings { settings ->
    settings.pluginManagement.repositories {
        maven { url = uri('/path/to/hindsight/companion/gradle-plugin/build/repo') }
        gradlePluginPortal()
    }
}
```

```
./gradlew build --init-script local-plugin.init.gradle
```

## Developing it

`cd companion && ./gradlew :gradle-plugin:test` runs the TestKit tests: real builds of small sample projects (Error
Prone's warnings and errors, the fix and its deploy and CI exclusions, the off switches, and the hook through real
`git commit`s). The robot-starts check needs a WPILib robot, so it is tested by building real robot projects with the
init script above.
