package io.github.kevinclark.hindsight.gradle;

import net.ltgt.gradle.errorprone.CheckSeverity;
import net.ltgt.gradle.errorprone.ErrorProneOptions;
import net.ltgt.gradle.errorprone.ErrorPronePlugin;
import org.gradle.api.Project;
import org.gradle.api.plugins.ExtensionAware;
import org.gradle.api.tasks.compile.JavaCompile;

/**
 * Error Prone with its default checks, plus NullAway on the robot's package, all as warnings. In CI the two checks
 * whose every hit in the robot code we measured was a real bug (integer division, and {@code Optional<Alliance>}
 * compared with an {@code Alliance}) fail the build instead.
 */
final class ErrorProneChecks {
  // The last Error Prone that runs on JDK 17, which WPILib 2025 and 2026 bundle
  static final String ERROR_PRONE = "com.google.errorprone:error_prone_core:2.42.0";
  static final String NULLAWAY = "com.uber.nullaway:nullaway:0.12.10";
  static final String GENERATED_CODE = ".*/build/generated/.*"; // AdvantageKit's AutoLog classes
  static final String[] STRICT_IN_CI = {"NarrowCalculation", "EqualsIncompatibleType"};

  private ErrorProneChecks() {}

  static void apply(Project project, HindsightExtension settings, BuildContext build) {
    project.getPluginManager().apply(ErrorPronePlugin.class);
    project.getDependencies().add(ErrorPronePlugin.CONFIGURATION_NAME, ERROR_PRONE);
    project.getDependencies().add(ErrorPronePlugin.CONFIGURATION_NAME, NULLAWAY);
    boolean strict = build.ci() && settings.getStrictInCi().get();
    String robotPackage = settings.robotPackage();
    project.getTasks().withType(JavaCompile.class).configureEach(task -> {
      ErrorProneOptions errorProne = options(task);
      errorProne.getExcludedPaths().set(GENERATED_CODE);
      if (robotPackage.isEmpty()) {
        errorProne.disable("NullAway"); // NullAway needs a package to check; a robot class with none gives none
      } else {
        errorProne.check("NullAway", CheckSeverity.WARN);
        errorProne.option("NullAway:AnnotatedPackages", robotPackage);
      }
      if (strict) errorProne.error(STRICT_IN_CI);
    });
  }

  static ErrorProneOptions options(JavaCompile task) {
    return ((ExtensionAware) task.getOptions()).getExtensions().getByType(ErrorProneOptions.class);
  }
}
