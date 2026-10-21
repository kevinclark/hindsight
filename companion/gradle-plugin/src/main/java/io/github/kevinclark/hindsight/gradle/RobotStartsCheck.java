package io.github.kevinclark.hindsight.gradle;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import org.gradle.api.GradleException;
import org.gradle.api.Project;
import org.gradle.api.Task;
import org.gradle.api.file.Directory;
import org.gradle.api.provider.Provider;
import org.gradle.api.tasks.JavaExec;
import org.gradle.api.tasks.SourceSet;
import org.gradle.api.tasks.SourceSetContainer;
import org.gradle.api.tasks.TaskProvider;
import org.gradle.api.tasks.compile.JavaCompile;

/**
 * The robot-starts check: builds the team's robot in simulation, connects a Driver Station after it boots (as at the
 * field) and runs the real robot loop through disabled, auto, teleop and disabled. It fails on any exception, or on
 * a loop that stops. It runs in {@code check}, so on every "Build Robot Code" and in CI, never on deploy.
 *
 * <p>The check ({@code HindsightRobotStarts.java}, a resource of this plugin) is written into {@code build/} and
 * compiled against the robot's own WPILib, because WPILib's classes change between years; the team writes no file.
 * It runs as its own Java process (one robot per JVM: AdvantageKit's Logger can't start twice), with the robot's
 * console output, Phoenix's and WPILib's native messages included, sent to a file rather than the build output.
 */
final class RobotStartsCheck {
  private static final String NAME = "hindsightRobotStarts";
  private static final String MAIN = "io.github.kevinclark.hindsight.robotstarts.HindsightRobotStarts";
  private static final String SOURCE = "HindsightRobotStarts.java";
  private static final Duration TIMEOUT = Duration.ofMinutes(3); // backstop; the check's own limits are shorter

  private RobotStartsCheck() {}

  static void apply(Project project, HindsightExtension settings) {
    if (!project.getPluginManager().hasPlugin("edu.wpi.first.GradleRIO")) {
      project.getLogger().info("Hindsight's robot-starts check needs GradleRIO (a WPILib robot project); skipped.");
      return;
    }
    Provider<Directory> sourceDir = project.getLayout().getBuildDirectory().dir("generated/sources/hindsight/java");
    TaskProvider<Task> writeSource = project.getTasks().register(NAME + "Source", task -> {
      task.setDescription("Writes Hindsight's robot-starts check into build/.");
      String source = readSource();
      task.getInputs().property("source", source); // a new plugin version rewrites it
      task.getOutputs().dir(sourceDir);
      task.doLast(t -> {
        project.delete(sourceDir);
        write(sourceDir.get().getAsFile().toPath().resolve(MAIN.replace('.', '/') + ".java"), source);
      });
    });

    SourceSetContainer sourceSets = project.getExtensions().getByType(SourceSetContainer.class);
    SourceSet main = sourceSets.getByName(SourceSet.MAIN_SOURCE_SET_NAME);
    SourceSet check = sourceSets.create(NAME);
    check.getJava().setSrcDirs(List.of(writeSource)); // the task's output, so compiling it runs the task first
    check.setCompileClasspath(main.getOutput().plus(main.getCompileClasspath()));
    check.setRuntimeClasspath(check.getOutput().plus(main.getRuntimeClasspath()));
    // Error Prone checks the team's code, not this check
    project.getPluginManager().withPlugin("net.ltgt.errorprone", plugin ->
        project.getTasks().named(check.getCompileJavaTaskName(), JavaCompile.class)
            .configure(task -> ErrorProneChecks.options(task).getEnabled().set(false)));

    Provider<Directory> outDir = project.getLayout().getBuildDirectory().dir("hindsight/robot-starts");
    TaskProvider<JavaExec> run = project.getTasks().register(NAME, JavaExec.class, task -> {
      task.setGroup("verification");
      task.setDescription("Builds the robot in simulation and runs it through disabled, auto, teleop and disabled.");
      task.getMainClass().set(MAIN);
      task.setClasspath(check.getRuntimeClasspath());
      task.setWorkingDir(project.getProjectDir()); // where WPILib looks for src/main/deploy in simulation
      task.getTimeout().set(TIMEOUT);
      WpilibNatives.configure(project, task);
      File output = outDir.get().file("output.txt").getAsFile();
      File result = outDir.get().file("result.txt").getAsFile();
      task.systemProperty("hindsight.robotClass", settings.getRobotClass().get());
      task.systemProperty("hindsight.result", result.getAbsolutePath());
      task.getOutputs().file(result); // up to date while the robot's classes are unchanged
      task.setIgnoreExitValue(true);
      OutputStream[] log = new OutputStream[1];
      task.doFirst(t -> {
        try {
          Files.createDirectories(output.toPath().getParent());
          Files.deleteIfExists(result.toPath());
          log[0] = new FileOutputStream(output);
        } catch (IOException e) {
          throw new UncheckedIOException(e);
        }
        task.setStandardOutput(log[0]);
        task.setErrorOutput(log[0]);
      });
      task.doLast(t -> {
        try {
          log[0].close();
          String verdict = result.exists() ? Files.readString(result.toPath()) : "";
          if (verdict.equals("passed")) return;
          Files.deleteIfExists(result.toPath()); // a failure is never up to date
          throw new GradleException((verdict.isEmpty() ? "Hindsight's robot-starts check stopped before it finished."
              : verdict) + "\nThe robot's console output: " + relative(project, output)
              + "\n(If this only happens in simulation, the check can be turned off: hindsight { robotStarts = false }"
              + " in build.gradle.)");
        } catch (IOException e) {
          throw new UncheckedIOException(e);
        }
      });
    });
    project.getTasks().named("check").configure(task -> task.dependsOn(run));
  }

  private static String relative(Project project, File file) {
    return project.getProjectDir().toPath().relativize(file.toPath()).toString();
  }

  private static String readSource() {
    try (InputStream source = RobotStartsCheck.class.getResourceAsStream(SOURCE)) {
      return new String(source.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static void write(Path target, String text) {
    try {
      Files.createDirectories(target.getParent());
      Files.writeString(target, text);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
