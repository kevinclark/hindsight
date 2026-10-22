package io.github.kevinclark.hindsight.gradle;

import java.util.List;
import net.ltgt.gradle.errorprone.CheckSeverity;
import net.ltgt.gradle.errorprone.ErrorProneOptions;
import net.ltgt.gradle.errorprone.ErrorPronePlugin;
import org.gradle.api.Project;
import org.gradle.api.plugins.ExtensionAware;
import org.gradle.api.tasks.compile.JavaCompile;

/**
 * Error Prone with an allowlist: every Error Prone warning is off except the few worth a student's attention. Alerts
 * are checks whose every hit in the robot code we measured was a real bug; they warn on laptops and fail the build
 * in CI. Tidy checks have a safe fix that {@link AutoFix} applies on laptop builds. Javadoc checks and the rest stay
 * off; javac's own warnings (deprecated for removal, say) are untouched. NullAway is on only when the team asks.
 */
final class ErrorProneChecks {
  // The last Error Prone that runs on JDK 17, which WPILib 2025 and 2026 bundle
  static final String ERROR_PRONE = "com.google.errorprone:error_prone_core:2.42.0";
  static final String NULLAWAY = "com.uber.nullaway:nullaway:0.12.10";
  static final String GENERATED_CODE = ".*/build/generated/.*"; // AdvantageKit's AutoLog classes
  static final String INTEGER_DIVISION = "NarrowCalculation";
  static final List<String> ALERTS = List.of(INTEGER_DIVISION, "EqualsIncompatibleType", "FallThrough");
  // not PatternMatchingInstanceof: its fix names the new variable by lower-casing the type (cANcoderIOSim)
  static final List<String> TIDY = List.of(
      "MissingOverride", "UnnecessaryParentheses", "OperatorPrecedence", "UnnecessaryStringBuilder");

  private ErrorProneChecks() {}

  static void apply(Project project, HindsightExtension settings, BuildContext build) {
    project.getPluginManager().apply(ErrorPronePlugin.class);
    project.getDependencies().add(ErrorPronePlugin.CONFIGURATION_NAME, ERROR_PRONE);
    String robotPackage = settings.robotPackage();
    boolean nullAway = settings.getNullAway().get() && !robotPackage.isEmpty(); // NullAway needs a package to check
    if (nullAway) project.getDependencies().add(ErrorPronePlugin.CONFIGURATION_NAME, NULLAWAY);
    CheckSeverity alert = build.ci() && settings.getStrictInCi().get() ? CheckSeverity.ERROR : CheckSeverity.WARN;
    project.getTasks().withType(JavaCompile.class).configureEach(task -> {
      ErrorProneOptions errorProne = options(task);
      errorProne.getExcludedPaths().set(GENERATED_CODE);
      errorProne.getDisableAllWarnings().set(true);
      ALERTS.forEach(check -> errorProne.check(check, alert));
      TIDY.forEach(check -> errorProne.check(check, CheckSeverity.WARN));
      if (nullAway) {
        errorProne.check("NullAway", CheckSeverity.WARN);
        errorProne.option("NullAway:AnnotatedPackages", robotPackage);
      }
    });
  }

  static ErrorProneOptions options(JavaCompile task) {
    return ((ExtensionAware) task.getOptions()).getExtensions().getByType(ErrorProneOptions.class);
  }
}
