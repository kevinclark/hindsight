package io.github.kevinclark.hindsight.gradle;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.time.Duration;
import org.gradle.api.GradleException;
import org.gradle.api.Project;
import org.gradle.api.Task;
import org.gradle.api.file.Directory;
import org.gradle.api.provider.Provider;
import org.gradle.api.tasks.JavaExec;
import org.gradle.api.tasks.PathSensitivity;
import org.gradle.api.tasks.SourceSet;
import org.gradle.api.tasks.SourceSetContainer;
import org.gradle.api.tasks.TaskProvider;
import org.gradle.api.tasks.compile.JavaCompile;

/**
 * The robot-starts check: builds the team's robot in simulation, connects a Driver Station after it boots (as at the
 * field) and runs the real robot loop through disabled, auto, teleop and disabled. It fails on any exception, or on
 * a loop that stops or never reaches a mode. It runs in {@code check}, so on every "Build Robot Code" and in CI, never
 * on deploy.
 *
 * <p>The check ({@code HindsightRobotStarts.java}, a resource of this plugin) is written into {@code build/} and
 * compiled against the robot's own WPILib, because WPILib's classes change between years; the team writes no file.
 * It is compiled by a task of its own, not a source set, so the team's Spotless or Checkstyle never sees it. It runs
 * as its own Java process (one robot per JVM: AdvantageKit's Logger can't start twice), with the robot's console
 * output, Phoenix's and WPILib's native messages included, sent to a file rather than the build output.
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
    Provider<Directory> dir = project.getLayout().getBuildDirectory().dir("hindsight/robot-starts");
    SourceSet main = project.getExtensions().getByType(SourceSetContainer.class)
        .getByName(SourceSet.MAIN_SOURCE_SET_NAME);
    TaskProvider<Task> source = registerSource(project, dir.map(d -> d.dir("src")));
    TaskProvider<JavaCompile> compile = project.getTasks().register(NAME + "Compile", JavaCompile.class, task -> {
      task.setDescription("Compiles Hindsight's robot-starts check against the robot's own classes.");
      task.setSource(source);
      task.setClasspath(main.getOutput().plus(main.getCompileClasspath()));
      task.getOptions().setAnnotationProcessorPath(project.files());
      task.getDestinationDirectory().set(dir.map(d -> d.dir("classes")));
      // Error Prone checks the team's code, not this check
      project.getPluginManager().withPlugin("net.ltgt.errorprone",
          plugin -> ErrorProneChecks.options(task).getEnabled().set(false));
    });
    TaskProvider<JavaExec> run = project.getTasks().register(NAME, JavaExec.class, task -> {
      task.setGroup("verification");
      task.setDescription("Builds the robot in simulation and runs it through disabled, auto, teleop and disabled.");
      task.getMainClass().set(MAIN);
      task.setClasspath(project.files(compile).plus(main.getRuntimeClasspath()));
      task.setWorkingDir(project.getProjectDir()); // where WPILib looks for src/main/deploy in simulation
      // robot code reads its autos and paths from there when it starts, so a change there reruns the check
      task.getInputs().dir(project.file("src/main/deploy")).optional().withPathSensitivity(PathSensitivity.RELATIVE)
          .withPropertyName("deployFiles");
      task.getTimeout().set(TIMEOUT);
      task.systemProperty("hindsight.robotClass", settings.getRobotClass().get());
      WpilibNatives.configure(project, task);
      reportInPlainWords(project, task, dir.get().file("output.txt").getAsFile(),
          dir.get().file("result.txt").getAsFile());
    });
    project.getTasks().named("check").configure(task -> task.dependsOn(run));
  }

  private static TaskProvider<Task> registerSource(Project project, Provider<Directory> sourceDir) {
    String source = readSource();
    return project.getTasks().register(NAME + "Source", task -> {
      task.setDescription("Writes Hindsight's robot-starts check into build/.");
      task.getInputs().property("source", source); // a new plugin version rewrites it
      task.getOutputs().dir(sourceDir);
      task.doLast(t -> {
        File file = sourceDir.get().file(MAIN.replace('.', '/') + ".java").getAsFile();
        project.delete(sourceDir);
        write(file, source);
      });
    });
  }

  /**
   * The robot's console output goes to {@code output}; the check writes its verdict to {@code result}: "passed", or
   * what went wrong in words for a student, which becomes the build's failure message.
   */
  private static void reportInPlainWords(Project project, JavaExec task, File output, File result) {
    task.systemProperty("hindsight.result", result.getAbsolutePath());
    task.getOutputs().file(result); // a pass stays up to date until the robot's code or deploy files change
    task.setIgnoreExitValue(true);
    task.doFirst(t -> {
      try {
        Files.createDirectories(output.toPath().getParent());
        Files.deleteIfExists(result.toPath());
        FileOutputStream log = new FileOutputStream(output);
        task.setStandardOutput(log);
        task.setErrorOutput(log);
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    });
    task.doLast(t -> {
      try {
        task.getStandardOutput().close();
        String verdict = result.exists() ? Files.readString(result.toPath()) : "";
        if (verdict.equals("passed")) return;
        Files.deleteIfExists(result.toPath()); // a failure is never up to date
        throw new GradleException((verdict.isEmpty() ? "Hindsight's robot-starts check stopped before it finished."
            : verdict) + "\nThe robot's console output: " + project.relativePath(output)
            + "\n(If this only happens in simulation, the check can be turned off: hindsight { robotStarts = false }"
            + " in build.gradle.)");
      } catch (IOException e) {
        throw new UncheckedIOException(e);
      }
    });
  }

  private static String readSource() {
    try (InputStream source = RobotStartsCheck.class.getResourceAsStream(SOURCE)) {
      return new String(source.readAllBytes(), StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static void write(File file, String text) {
    try {
      Files.createDirectories(file.toPath().getParent());
      Files.writeString(file.toPath(), text);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
