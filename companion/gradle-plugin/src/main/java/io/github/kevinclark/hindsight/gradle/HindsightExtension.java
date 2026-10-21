package io.github.kevinclark.hindsight.gradle;

import org.gradle.api.provider.Property;

/**
 * The {@code hindsight {}} block. Everything is on by default; a team turns a check off by name:
 *
 * <pre>
 * hindsight {
 *     robotStarts = false
 * }
 * </pre>
 */
public abstract class HindsightExtension {
  /** Error Prone and NullAway, as warnings. Off also turns off the two checks below that need it. */
  public abstract Property<Boolean> getErrorProne();

  /** Rewrite integer division that loses its fraction ({@code 50 / 12} to {@code 50 / 12.0}) on laptop builds. */
  public abstract Property<Boolean> getFixIntegerDivision();

  /** In CI ({@code CI=true}), integer division and {@code equals} between unrelated types fail the build. */
  public abstract Property<Boolean> getStrictInCi();

  /** Build the robot and run it through disabled, auto, teleop and disabled in simulation, in {@code check}. */
  public abstract Property<Boolean> getRobotStarts();

  /** The robot class the robot-starts check builds. */
  public abstract Property<String> getRobotClass();

  /** A git pre-commit hook that runs the project's own {@code spotlessApply} on the files being committed. */
  public abstract Property<Boolean> getFormatHook();

  /** The robot's package ({@code frc.robot} for {@code frc.robot.Robot}): NullAway checks code in it. */
  String robotPackage() {
    String robotClass = getRobotClass().get();
    return robotClass.substring(0, Math.max(0, robotClass.lastIndexOf('.')));
  }
}
