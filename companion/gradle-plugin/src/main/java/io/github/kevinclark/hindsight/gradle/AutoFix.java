package io.github.kevinclark.hindsight.gradle;

import java.io.File;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import net.ltgt.gradle.errorprone.ErrorProneOptions;
import org.gradle.api.Project;
import org.gradle.api.file.Directory;
import org.gradle.api.logging.StandardOutputListener;
import org.gradle.api.provider.Provider;
import org.gradle.api.tasks.TaskProvider;
import org.gradle.api.tasks.compile.JavaCompile;

/**
 * Applies Error Prone's own fixes on laptop builds: integer division that loses its fraction ({@code 50 / 12} is 4,
 * so it becomes {@code 50 / 12.0}) and the tidy checks (a missing {@code @Override}, extra parentheses, ...).
 *
 * <p>Error Prone's patch mode runs only the checks it patches, so patching inside {@code compileJava} would hide
 * every other warning. Instead {@code compileJava} warns as usual, and only a build whose compile warned about one of
 * these checks runs a second, patch-only compile. The rewrite lands after the classes are built, so that build still
 * has the old code and says so. Never under a deploy: the robot would get the old code and the next deploy would
 * change it with no edit. Never in CI, which checks what was committed.
 */
final class AutoFix {
  private static final int MAX_WARNINGS = 10_000;
  // "/path/Foo.java:50: warning: [NarrowCalculation] ..." as the task's error stream carries it
  private static final Pattern WARNING = Pattern.compile("(?m)^(.+\\.java):\\d+: warning: \\[(\\w+)\\]");

  private AutoFix() {}

  static void apply(Project project, HindsightExtension settings, BuildContext build) {
    List<String> checks = new ArrayList<>();
    if (settings.getFixIntegerDivision().get()) checks.add(ErrorProneChecks.INTEGER_DIVISION);
    if (settings.getFixStyle().get()) checks.addAll(ErrorProneChecks.TIDY);
    if (checks.isEmpty()) return;

    TaskProvider<JavaCompile> compileJava = project.getTasks().named("compileJava", JavaCompile.class);
    Provider<Directory> dir = project.getLayout().getBuildDirectory().dir("hindsight/auto-fix");
    // what compileJava warned about ("check<TAB>file" lines), deleted once fixed: a build whose compileJava is up to
    // date (after a deploy that didn't fix, say) still fixes
    File pending = dir.get().file("pending").getAsFile();
    TaskProvider<JavaCompile> fix = project.getTasks().register("hindsightAutoFix", JavaCompile.class, task -> {
      JavaCompile main = compileJava.get();
      task.setDescription("Applies Error Prone's fixes for integer division and the tidy checks (laptop builds only).");
      task.setSource(main.getSource());
      task.setClasspath(main.getClasspath());
      task.getOptions().setAnnotationProcessorPath(main.getOptions().getAnnotationProcessorPath());
      task.getOptions().getCompilerArgs().addAll(main.getOptions().getCompilerArgs());
      task.getOptions().getCompilerArgs().add("-nowarn"); // compileJava already showed these warnings
      task.getOptions().getRelease().set(main.getOptions().getRelease());
      task.getOptions().setEncoding(main.getOptions().getEncoding());
      task.getOptions().setFailOnError(false); // a tool's second compile must never fail the team's build
      task.getOptions().getGeneratedSourceOutputDirectory().set(dir.map(d -> d.dir("generated")));
      task.getDestinationDirectory().set(dir.map(d -> d.dir("classes")));
      ErrorProneOptions errorProne = ErrorProneChecks.options(task);
      errorProne.getEnabled().set(true);
      errorProne.getErrorproneArgs().addAll("-XepPatchChecks:" + String.join(",", checks), "-XepPatchLocation:IN_PLACE");
      task.onlyIf("compileJava warned about a check it fixes",
          t -> pending.exists() && main.getState().getFailure() == null);
      task.onlyIf("not deploying", t -> !build.deploying());
      // its job is the rewrite, which no output records, so never up to date and never from the build cache
      task.getOutputs().upToDateWhen(t -> false);
      task.getOutputs().cacheIf("rewrites source", t -> false);
      Map<File, Long> before = new HashMap<>();
      task.doFirst(t -> {
        before.clear();
        main.getSource().forEach(file -> before.put(file, file.lastModified()));
      });
      task.doLast(t -> {
        report(project, changed(before), divisionFiles(pending));
        project.delete(pending);
      });
    });
    compileJava.configure(task -> {
      // javac stops printing at 100 warnings, and a warning it doesn't print isn't fixed
      task.getOptions().getCompilerArgs().addAll(List.of("-Xmaxwarns", String.valueOf(MAX_WARNINGS)));
      Set<String> warned = new TreeSet<>();
      task.getLogging().addStandardErrorListener((StandardOutputListener) output -> {
        Matcher warning = WARNING.matcher(output);
        while (warning.find()) {
          if (checks.contains(warning.group(2))) warned.add(warning.group(2) + "\t" + warning.group(1));
        }
      });
      task.doFirst(t -> {
        warned.clear();
        project.delete(pending);
      });
      task.doLast(t -> {
        if (!warned.isEmpty()) write(pending, String.join("\n", warned) + "\n");
      });
      task.finalizedBy(fix);
    });
  }

  private static Set<File> changed(Map<File, Long> before) {
    return before.entrySet().stream()
        .filter(file -> file.getKey().lastModified() != file.getValue())
        .map(Map.Entry::getKey)
        .collect(Collectors.toSet());
  }

  /** The files compileJava warned about integer division in, from the pending list. */
  private static Set<File> divisionFiles(File pending) {
    try {
      return Files.readAllLines(pending.toPath()).stream()
          .filter(line -> line.startsWith(ErrorProneChecks.INTEGER_DIVISION + "\t"))
          .map(line -> new File(line.substring(line.indexOf('\t') + 1)))
          .collect(Collectors.toSet());
    } catch (IOException e) {
      return Set.of();
    }
  }

  private static void report(Project project, Set<File> changed, Set<File> divisions) {
    if (changed.isEmpty()) return;
    List<String> divided = changed.stream().filter(divisions::contains).map(project::relativePath).sorted()
        .collect(Collectors.toList());
    long tidied = changed.size() - divided.size();
    List<String> lines = new ArrayList<>(List.of(""));
    if (!divided.isEmpty()) {
      lines.add("Hindsight fixed integer division in " + files(divided.size())
          + " (in Java 50 / 12 is 4, so it now reads 50 / 12.0):");
      divided.forEach(file -> lines.add("  " + file));
    }
    if (tidied > 0) {
      lines.add("Hindsight tidied " + files(tidied) + (divided.isEmpty() ? "" : " more")
          + " (a missing @Override, extra parentheses, a StringBuilder that isn't needed, ...).");
    }
    lines.add("This build still has the old code. Check the change (git diff), then build again.");
    lines.add("To keep one as it is, add @SuppressWarnings(\"<the check's name>\") to its field or method.");
    lines.add("");
    project.getLogger().warn(String.join("\n", lines));
  }

  private static String files(long count) {
    return count + (count == 1 ? " file" : " files");
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
