package io.github.kevinclark.hindsight.gradle;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.gradle.testkit.runner.TaskOutcome.SKIPPED;

import java.nio.file.Path;
import org.gradle.testkit.runner.BuildResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class IntegerDivisionTest {
  private static final String FIX_TASK = ":hindsightFixIntegerDivision";

  @TempDir Path dir;

  @Test
  void laptopBuildWarnsThenRewritesTheSource() {
    Sample sample = Sample.in(dir);
    BuildResult result = sample.build(false, "compileJava");

    assertTrue(result.getOutput().contains("[NarrowCalculation]"), result.getOutput());
    assertTrue(result.getOutput().contains("[EqualsIncompatibleType]"), result.getOutput());
    assertTrue(sample.read(Sample.RATIOS).contains("50 / 12.0"));
    assertTrue(result.getOutput().contains("Hindsight fixed integer division in 1 file"), result.getOutput());
    assertTrue(result.getOutput().contains("  " + Sample.RATIOS), result.getOutput());
  }

  @Test
  void secondBuildHasNothingLeftToFix() {
    Sample sample = Sample.in(dir);
    sample.build(false, "compileJava");
    BuildResult second = sample.build(false, "compileJava");

    assertFalse(second.getOutput().contains("[NarrowCalculation]"), second.getOutput());
    assertEquals(SKIPPED, second.task(FIX_TASK).getOutcome());
  }

  @Test
  void deployLeavesTheSourceAlone() {
    // GradleRIO's deploy tasks are DeployUtils types; this stands in for one
    Sample sample = Sample.in(dir).buildLine("tasks.register('deploy', edu.wpi.first.deployutils.deploy.FakeDeploy) "
        + "{ dependsOn 'compileJava' }");
    sample.write("buildSrc/src/main/java/edu/wpi/first/deployutils/deploy/FakeDeploy.java",
        "package edu.wpi.first.deployutils.deploy;\n"
            + "public class FakeDeploy extends org.gradle.api.DefaultTask {}\n");
    BuildResult result = sample.build(false, "deploy");

    assertEquals(Sample.RATIOS_SOURCE, sample.read(Sample.RATIOS));
    assertEquals(SKIPPED, result.task(FIX_TASK).getOutcome());
  }

  @Test
  void aTaskNamedDeployThatIsNotOneStillFixes() {
    // robot projects have tasks like eventDeploy that run on every build
    Sample sample = Sample.in(dir).buildLine("tasks.register('eventDeploy'); compileJava.dependsOn 'eventDeploy'");
    sample.build(false, "compileJava");

    assertTrue(sample.read(Sample.RATIOS).contains("50 / 12.0"));
  }

  @Test
  void ciFailsOnIntegerDivisionAndRewritesNothing() {
    Sample sample = Sample.in(dir);
    BuildResult result = sample.buildAndFail(true, "compileJava");

    assertTrue(result.getOutput().contains("error: [NarrowCalculation]"), result.getOutput());
    assertEquals(Sample.RATIOS_SOURCE, sample.read(Sample.RATIOS));
    assertNull(result.task(FIX_TASK));
  }

  @Test
  void fixIntegerDivisionOffKeepsTheWarningAndTheSource() {
    Sample sample = Sample.in(dir).setting("fixIntegerDivision = false");
    BuildResult result = sample.build(false, "compileJava");

    assertTrue(result.getOutput().contains("[NarrowCalculation]"), result.getOutput());
    assertEquals(Sample.RATIOS_SOURCE, sample.read(Sample.RATIOS));
    assertNull(result.task(FIX_TASK));
  }

  @Test
  void errorProneOffHasNoErrorProneWarnings() {
    BuildResult result = Sample.in(dir).setting("errorProne = false").build(false, "compileJava");

    assertFalse(result.getOutput().contains("[NarrowCalculation]"), result.getOutput());
  }

  @Test
  void strictInCiOffOnlyWarnsInCi() {
    BuildResult result = Sample.in(dir).setting("strictInCi = false").build(true, "compileJava");

    assertTrue(result.getOutput().contains("warning: [NarrowCalculation]"), result.getOutput());
  }
}
