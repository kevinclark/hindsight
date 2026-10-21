package io.github.kevinclark.hindsight.gradle;

import java.io.File;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Collectors;
import net.ltgt.gradle.errorprone.ErrorProneOptions;
import org.gradle.api.Project;
import org.gradle.api.logging.StandardOutputListener;
import org.gradle.api.tasks.TaskProvider;
import org.gradle.api.tasks.compile.JavaCompile;

/**
 * Fixes integer division that loses its fraction ({@code 50 / 12} is 4, so it becomes {@code 50 / 12.0}) on laptop
 * builds, with Error Prone's own fix for {@code NarrowCalculation}.
 *
 * <p>Error Prone's patch mode runs only the checks it patches, so patching inside {@code compileJava} would hide
 * every other warning. Instead {@code compileJava} warns as usual, and only a build whose compile warned about
 * integer division runs a second, patch-only compile. The rewrite lands after the classes are built, so that build
 * still has the old values and says so. Never under a deploy: the robot would get the old values and the next
 * deploy would change them with no edit.
 */
final class IntegerDivisionFix {
  private static final String CHECK = "NarrowCalculation";

  private IntegerDivisionFix() {}

  static void apply(Project project, BuildContext build) {
    TaskProvider<JavaCompile> compileJava = project.getTasks().named("compileJava", JavaCompile.class);
    AtomicBoolean warned = new AtomicBoolean();
    TaskProvider<JavaCompile> fix = project.getTasks().register("hindsightFixIntegerDivision", JavaCompile.class, task -> {
      JavaCompile main = compileJava.get();
      task.setDescription("Rewrites integer division that loses its fraction (laptop builds only).");
      task.setSource(main.getSource());
      task.setClasspath(main.getClasspath());
      task.getOptions().setAnnotationProcessorPath(main.getOptions().getAnnotationProcessorPath());
      task.getOptions().getGeneratedSourceOutputDirectory()
          .set(project.getLayout().getBuildDirectory().dir("hindsight/fix-integer-division/generated"));
      task.getDestinationDirectory().set(project.getLayout().getBuildDirectory().dir("hindsight/fix-integer-division/classes"));
      ErrorProneOptions errorProne = ErrorProneChecks.options(task);
      errorProne.getEnabled().set(true);
      errorProne.getErrorproneArgs().addAll("-XepPatchChecks:" + CHECK, "-XepPatchLocation:IN_PLACE");
      task.onlyIf("compileJava warned about integer division", t -> warned.get() && main.getState().getFailure() == null);
      task.onlyIf("not deploying", t -> !build.deploying());
      task.getOutputs().upToDateWhen(t -> false); // its job is the rewrite, which no output records
      task.getOptions().getCompilerArgs().add("-nowarn"); // compileJava already showed these warnings
      Map<File, Long> before = new HashMap<>();
      task.doFirst(t -> {
        before.clear();
        main.getSource().forEach(file -> before.put(file, file.lastModified()));
      });
      task.doLast(t -> report(project, before));
    });
    compileJava.configure(task -> {
      // javac stops printing at 100 warnings (Rebuilt reaches it), and a division it doesn't print isn't fixed
      task.getOptions().getCompilerArgs().addAll(List.of("-Xmaxwarns", "10000"));
      task.doFirst(t -> warned.set(false));
      // compile warnings reach the task's error stream as "File.java:50: warning: [NarrowCalculation] ..."
      task.getLogging().addStandardErrorListener((StandardOutputListener) output -> {
        if (output.toString().contains("[" + CHECK + "]")) warned.set(true);
      });
      task.finalizedBy(fix);
    });
  }

  private static void report(Project project, Map<File, Long> before) {
    List<String> fixed = before.entrySet().stream()
        .filter(file -> file.getKey().lastModified() != file.getValue())
        .map(file -> project.getProjectDir().toPath().relativize(file.getKey().toPath()).toString())
        .sorted()
        .collect(Collectors.toList());
    if (fixed.isEmpty()) return;
    project.getLogger().warn(String.join("\n",
        "",
        "Hindsight fixed integer division in " + fixed.size() + (fixed.size() == 1 ? " file" : " files")
            + " (in Java 50 / 12 is 4, so it now reads 50 / 12.0):",
        fixed.stream().map(file -> "  " + file).collect(Collectors.joining("\n")),
        "This build still has the old values. Check the change (git diff), then build again.",
        "To keep a whole-number division on purpose, add @SuppressWarnings(\"" + CHECK + "\") to its field or method.",
        ""));
  }
}
