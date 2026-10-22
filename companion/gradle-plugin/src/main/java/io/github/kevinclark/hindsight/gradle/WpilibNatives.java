package io.github.kevinclark.hindsight.gradle;

import java.io.File;
import java.util.Map;
import org.gradle.api.GradleException;
import org.gradle.api.Project;
import org.gradle.api.Task;
import org.gradle.api.file.DirectoryProperty;
import org.gradle.api.provider.Property;
import org.gradle.api.tasks.JavaExec;
import org.gradle.api.tasks.TaskProvider;

/**
 * WPILib's desktop native libraries (HAL, the simulator, vendor JNI) for a Java process, set up the way GradleRIO's
 * {@code wpi.java.configureTestTasks(test)} does for tests. GradleRIO is reached by reflection because the plugin
 * can't depend on one GradleRIO year; these getters are public in 2025 and 2026.
 */
final class WpilibNatives {
  private WpilibNatives() {}

  static void configure(Project project, JavaExec task) {
    TaskProvider<?> extract = extractTask(project);
    task.dependsOn(extract);
    task.doFirst(t -> {
      String dir = destination(extract.get()).get().getAsFile().getAbsolutePath();
      if (File.separatorChar == '\\') {
        task.environment("PATH", dir + File.pathSeparator + System.getenv("PATH"));
      } else {
        task.environment(Map.of("LD_LIBRARY_PATH", dir, "DYLD_FALLBACK_LIBRARY_PATH", dir, "DYLD_LIBRARY_PATH", dir));
      }
      Object libraryPath = task.getSystemProperties().get("java.library.path");
      task.systemProperty("java.library.path", libraryPath == null ? dir : libraryPath + File.pathSeparator + dir);
    });
  }

  private static TaskProvider<?> extractTask(Project project) {
    try {
      Object wpi = project.getExtensions().getByName("wpi");
      Object java = wpi.getClass().getMethod("getJava").invoke(wpi);
      boolean debug = ((Property<?>) java.getClass().getMethod("getDebugJni").invoke(java)).get() == Boolean.TRUE;
      String getter = debug ? "getExtractNativeDebugArtifacts" : "getExtractNativeReleaseArtifacts";
      return (TaskProvider<?>) java.getClass().getMethod(getter).invoke(java);
    } catch (ReflectiveOperationException | ClassCastException e) {
      throw new GradleException("Hindsight's robot-starts check couldn't find WPILib's simulator libraries (" + e
          + "). Turn the check off with hindsight { robotStarts = false }, and tell us your GradleRIO version.", e);
    }
  }

  private static DirectoryProperty destination(Task extract) {
    try {
      return (DirectoryProperty) extract.getClass().getMethod("getDestinationDirectory").invoke(extract);
    } catch (ReflectiveOperationException e) {
      throw new GradleException("Hindsight couldn't read where GradleRIO put WPILib's simulator libraries.", e);
    }
  }
}
