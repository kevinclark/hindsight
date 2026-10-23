package io.github.kevinclark.hindsight.gradle;

import org.gradle.api.Plugin;
import org.gradle.api.Project;

/**
 * {@code id "io.github.kevinclark.hindsight"}: build checks for a WPILib robot project, each on by default and each
 * turned off by name in {@code hindsight {}}. The checks are wired after the build script has run, so they see the
 * team's settings.
 */
public class HindsightPlugin implements Plugin<Project> {
  @Override
  public void apply(Project project) {
    HindsightExtension settings = project.getExtensions().create("hindsight", HindsightExtension.class);
    settings.getErrorProne().convention(true);
    settings.getFixIntegerDivision().convention(true);
    settings.getFixStyle().convention(true);
    settings.getStrictInCi().convention(true);
    settings.getNullAway().convention(false);
    settings.getRobotStarts().convention(true);
    settings.getRobotStartsOnLaptop().convention(false);
    settings.getRobotClass().convention("frc.robot.Robot");
    settings.getFormatHook().convention(true);

    BuildContext build = BuildContext.of(project);
    project.afterEvaluate(p -> {
      if (!p.getPluginManager().hasPlugin("java")) {
        p.getLogger().warn("Hindsight checks Java robot projects; this project has no Java plugin, so it does nothing.");
        return;
      }
      if (settings.getErrorProne().get()) {
        ErrorProneChecks.apply(p, settings, build);
        if (!build.ci()) AutoFix.apply(p, settings, build);
      }
      if (settings.getRobotStarts().get()) RobotStartsCheck.apply(p, settings, build);
      if (!build.ci()) FormatHook.apply(p, settings.getFormatHook().get());
    });
  }
}
