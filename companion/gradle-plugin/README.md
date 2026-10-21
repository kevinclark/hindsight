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
| **Error Prone + NullAway** (`errorProne`) | every compile | Error Prone's default warnings, plus NullAway's on the robot's package (`frc.robot` for `frc.robot.Robot`). Generated code (AdvantageKit's `AutoLogged` classes) is skipped. Warnings only: they never stop a build. |
| **Integer division fixed** (`fixIntegerDivision`) | laptop builds that warned about it; never a deploy, never CI | `50 / 12` is 4 in Java. Error Prone rewrites it to `50 / 12.0` in place and the build lists each file it changed. The rewrite lands after that build compiled, so build again before you deploy. |
| **Strict in CI** (`strictInCi`) | `CI=true` (GitHub Actions sets it) | `NarrowCalculation` (integer division) and `EqualsIncompatibleType` (`Optional<Alliance>` compared with `Alliance`, always false) are errors. Everything else stays a warning. |
| **Robot starts** (`robotStarts`) | `check`, so every "Build Robot Code" and CI; never deploy | Builds `frc.robot.Robot` in simulation, connects a Driver Station after it boots (as at the field) and runs the real robot loop disabled, in auto, in teleop and disabled again. A crash fails the build with the exception and the lines of your code it went through. The robot's console output goes to `build/hindsight/robot-starts/output.txt`. |
| **Format hook** (`formatHook`) | each `git commit`, once the clone has built | Runs the project's own `spotlessApply` and re-stages the files you had staged. A file with unstaged changes is left as it is. It never blocks a commit; `--no-verify` skips it. |

A failing robot-starts check reads like this (Rebuilt `4b68c96^`, a field read before the constructor set it):

```
> The robot code crashed while building the robot (new Robot()):
    NullPointerException: Cannot invoke "com.ctre.phoenix6.hardware.TalonFX.getPosition()" because "this.hoodMotor" is null
    in your code at frc.robot.subsystems.hood.HoodIO.<init>(HoodIO.java:38)
              from frc.robot.subsystems.hood.HoodIOSim.<init>(HoodIOSim.java:30)
              from frc.robot.Robot.<init>(Robot.java:116)
  The real robot would crash the same way. Fix it, then build again.
```

## Turn something off

```groovy
hindsight {
    errorProne = false           // also turns off the two checks that use it
    fixIntegerDivision = false   // warn about integer division, don't rewrite it
    strictInCi = false           // CI warns instead of failing
    robotStarts = false
    formatHook = false           // the next build removes the hook it installed
    robotClass = "frc.robot.Robot"   // if your robot class has another name
}
```

To keep one whole-number division on purpose, put `@SuppressWarnings("NarrowCalculation")` on its field or method.

## Details

- **Why the fix waits for a second compile.** Error Prone's patch mode runs only the checks it patches, so patching
  inside `compileJava` would hide every other warning. `compileJava` warns as usual; only a build whose compile warned
  about integer division runs `hindsightFixIntegerDivision`, a patch-only compile into `build/`.
- **Why never on deploy.** A deploy ships what was just compiled, so it would carry the old values and the next deploy
  would change them with no edit. Any GradleRIO deploy task (a DeployUtils task, such as `deploy`'s roboRIO
  discovery) turns the fix off for that build; a task merely named like one, such as `eventDeploy`, doesn't. GradleRIO's
  `deploy` doesn't run `check`, so the robot-starts check never runs at the field either.
- **The robot-starts check** is written into `build/generated/sources/hindsight/` and compiled against your own
  WPILib, then run as its own Java process with WPILib's simulator libraries, the way GradleRIO runs tests. It is up
  to date (skipped) while your compiled code hasn't changed. Your code must build in simulation: an AdvantageKit robot
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
