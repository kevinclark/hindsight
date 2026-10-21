package io.github.kevinclark.hindsight.gradle;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.gradle.testkit.runner.BuildResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ErrorProneTest {
  private static final String NULL_RETURN = String.join("\n",
      "package frc.robot;",
      "",
      "public class Names {",
      "  public static String name() {",
      "    return null;",
      "  }",
      "}",
      "");

  @TempDir Path dir;

  @Test
  void nullAwayChecksTheRobotPackage() {
    Sample sample = Sample.in(dir).setting("fixIntegerDivision = false");
    sample.write("src/main/java/frc/robot/Names.java", NULL_RETURN);
    BuildResult result = sample.build(false, "compileJava");

    assertTrue(result.getOutput().contains("warning: [NullAway]"), result.getOutput());
  }

  @Test
  void nullAwayLeavesOtherPackagesAlone() {
    Sample sample = Sample.in(dir).setting("fixIntegerDivision = false").setting("robotClass = 'org.other.Robot'");
    sample.write("src/main/java/frc/robot/Names.java", NULL_RETURN);
    BuildResult result = sample.build(false, "compileJava");

    assertFalse(result.getOutput().contains("[NullAway]"), result.getOutput());
  }

  @Test
  void robotStartsIsSkippedWithoutGradleRio() {
    BuildResult result = Sample.in(dir).build(false, "tasks", "--all");

    assertFalse(result.getOutput().contains("hindsightRobotStarts"), result.getOutput());
  }

  @Test
  void withoutTheJavaPluginItWarnsAndDoesNothing() {
    BuildResult result = Sample.in(dir).withoutJavaPlugin().build(false, "tasks");

    assertTrue(result.getOutput().contains("has no Java plugin"), result.getOutput());
  }
}
