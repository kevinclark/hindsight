package io.github.kevinclark.hindsight.gradle;

import static org.junit.jupiter.api.Assertions.assertEquals;
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

  private static final String TIDY = "src/main/java/frc/robot/Tidy.java";
  // a missing @Override (tidy, fixed), a switch case that falls through (an alert), an empty Javadoc tag and an
  // unused variable (both off)
  private static final String TIDY_SOURCE = String.join("\n",
      "package frc.robot;",
      "",
      "public class Tidy {",
      "  /**",
      "   * @param x",
      "   */",
      "  public static int pick(int x) {",
      "    int unused = 3;",
      "    switch (x) {",
      "      case 1:",
      "        x++;",
      "      case 2:",
      "        return x;",
      "      default:",
      "        return 0;",
      "    }",
      "  }",
      "",
      "  public String toString() {",
      "    return \"tidy\";",
      "  }",
      "}",
      "");

  @TempDir Path dir;

  @Test
  void nullAwayChecksTheRobotPackage() {
    Sample sample = Sample.in(dir).setting("fixIntegerDivision = false").setting("nullAway = true");
    sample.write("src/main/java/frc/robot/Names.java", NULL_RETURN);
    BuildResult result = sample.build(false, "compileJava");

    assertTrue(result.getOutput().contains("warning: [NullAway]"), result.getOutput());
  }

  @Test
  void nullAwayIsOffUnlessAskedFor() {
    Sample sample = Sample.in(dir).setting("fixIntegerDivision = false");
    sample.write("src/main/java/frc/robot/Names.java", NULL_RETURN);
    BuildResult result = sample.build(false, "compileJava");

    assertFalse(result.getOutput().contains("[NullAway]"), result.getOutput());
  }

  @Test
  void onlyTheAllowlistWarns() {
    Sample sample = Sample.in(dir).setting("fixIntegerDivision = false").setting("fixStyle = false");
    sample.write(TIDY, TIDY_SOURCE);
    BuildResult result = sample.build(false, "compileJava");

    assertTrue(result.getOutput().contains("warning: [MissingOverride]"), result.getOutput());
    assertTrue(result.getOutput().contains("warning: [FallThrough]"), result.getOutput());
    assertFalse(result.getOutput().contains("[EmptyBlockTag]"), result.getOutput()); // Javadoc checks are off
    assertFalse(result.getOutput().contains("[UnusedVariable]"), result.getOutput()); // as is the rest
  }

  @Test
  void fallThroughFailsCi() {
    Sample sample = Sample.in(dir);
    sample.write(TIDY, TIDY_SOURCE);
    BuildResult result = sample.buildAndFail(true, "compileJava");

    assertTrue(result.getOutput().contains("error: [FallThrough]"), result.getOutput());
  }

  @Test
  void laptopBuildTidies() {
    Sample sample = Sample.in(dir).setting("fixIntegerDivision = false");
    sample.write(TIDY, TIDY_SOURCE);
    BuildResult result = sample.build(false, "compileJava");

    assertTrue(sample.read(TIDY).contains("@Override"), sample.read(TIDY));
    assertTrue(result.getOutput().contains("Hindsight tidied 1 file"), result.getOutput());
  }

  @Test
  void fixStyleOffLeavesItAlone() {
    Sample sample = Sample.in(dir).setting("fixStyle = false");
    sample.write(TIDY, TIDY_SOURCE);
    sample.build(false, "compileJava");

    assertEquals(TIDY_SOURCE, sample.read(TIDY));
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
